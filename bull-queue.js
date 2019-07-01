/**
 * Copyright 2013,2015 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function(RED) {
  "use strict";

  var sprintf = require("sprintf-js").sprintf;
  var Queue = require("bull");

  function BullQueueServerSetup(n) {
    RED.nodes.createNode(this, n);

    // Configuration options passed by Node Red
    this.name = n.name;
    this.address = n.address;
    this.port = n.port;

    // Config node state
    this.connected = false;
    this.connecting = false;
    this.closing = false;

    // Define functions called by MQTT in and out nodes
    var node = this;
    this.users = {};

    this.register = function(bullNode) {
      node.users[bullNode.id] = bullNode;
      if (Object.keys(node.users).length === 1) {
        node.connect();
      }
    };

    this.deregister = function(bullNode, done) {
      delete node.users[bullNode.id];
      if (node.closing) {
        return done();
      }
      if (Object.keys(node.users).length === 0) {
        if (node.queue && node.connected) {
          return node.queue.close(done);
        } else {
          node.queue.close();
          return done();
        }
      }
      done();
    };

    this.connect = function() {
      if (!node.connected && !node.connecting) {
        node.connecting = true;
        try {
          node.queue = Queue(node.name, node.port, node.address);
          node.log(sprintf("connected to %s:%d", node.address, node.port));
          node.connecting = false;
          node.connected = true;
          for (var id in node.users) {
            if (node.users.hasOwnProperty(id)) {
              node.users[id].status({
                fill: "green",
                shape: "dot",
                text: "node-red:common.status.connected"
              });
            }
          }
        } catch (err) {
          console.log(err);
        }
      }
      return node.queue;
    };

    this.on("close", function(removed, done) {
      this.closing = true;
      if (this.connected) {
        this.queue.once("close", function() {
          done();
        });
        this.queue.close();
        done();
      } else if (this.connecting || node.queue.reconnecting) {
        node.queue.close();
        done();
      } else {
        done();
      }
    });
  }

  RED.nodes.registerType("bull-queue-server", BullQueueServerSetup);

  function BullQueueCmdNode(n) {
    RED.nodes.createNode(this, n);
    this.queue = n.queue;
    this.bullConn = RED.nodes.getNode(this.queue);

    var node = this;

    if (this.bullConn) {
      this.bullConn.register(this);
      /*
      node.Queue.connect().then(
        function(queue) {
          node.status({
            fill: "green",
            shape: "dot",
            text: "connected"
          });
        },
        function(error) {
          node.status({
            fill: "red",
            shape: "ring",
            text: "disconnected"
          });
        }
      );
*/
    } else {
      node.error("common.status.error");
    }
    try {
      this.on("input", function(msg) {
        var bullqueue = node.bullConn.connect();

        switch (msg.cmd) {
          case "add":
            console.log("this is add");
            (async function(msg) {
              const jobs = await bullqueue.getRepeatableJobs();
              for (let i = 0; i < jobs.length; i++) {
                if (jobs[i].key.includes(msg.jobopts.jobId)) {
                  await bullqueue.removeRepeatableByKey(jobs[i].key);
                }
              }
              msg.payload = await bullqueue.add(
                { payload: msg.payload },
                msg.jobopts
              );
              node.send(msg);
            })(msg);
            break;
          case "count":
            console.log("this is count");
            (async function(msg) {
              msg.payload = await bullqueue.count();
              node.send(msg);
            })(msg);
            break;
          case "getRepeatableJobs":
            console.log("this is getRepeatableJobs");
            (async function(msg) {
              msg.payload = await bullqueue.getRepeatableJobs();
              node.send(msg);
            })(msg);
            break;
          case "removeRepeatableByKey":
            console.log("this is removeRepeatableByKey");
            (async function(msg) {
              const jobs = await bullqueue.getRepeatableJobs();
              if (msg.jobid !== undefined || msg.jobid !== null) {
                for (let i = 0; i < jobs.length; i++) {
                  if (jobs[i].key.includes(msg.jobid)) {
                    msg.payload = await bullqueue.removeRepeatableByKey(
                      jobs[i].key
                    );
                    console.log(msg.payload);
                    break;
                  }
                }
              } else {
                msg.payload = "no job id specified";
              }
              node.send(msg);
            })(msg);
            break;
          case "stopAndRemoveAllJobs":
            console.log("this is stopAndRemoveAllJobs");
            (async function(msg) {
              msg.payload = await bullqueue.empty();
              const jobs = await bullqueue.getRepeatableJobs();
              if (msg.payload === undefined || msg.payload === null) {
                msg.payload = "";
              }
              for (let i = 0; i < jobs.length; i++) {
                msg.payload = await bullqueue.removeRepeatableByKey(
                  jobs[i].key
                );
              }
              node.send(msg);
            })(msg);
            break;
          default:
            node.log("TBA " + msg.cmd);
            break;
        }

        /*
        node.Queue.connect().then(
          function(queue) {
            switch (parseInt(node.cmd)) {
              case 0:
                node.log(
                  "queue.add({payload:" +
                    msg.payload +
                    "}, " +
                    JSON.stringify(msg.jobopts) +
                    ")"
                );
                async function add(msg) {
                  return await queue.add({ payload: msg.payload }, msg.jobopts);
                }
                msg.result = add(msg);
                node.send(msg);
                break;
              case 1:
                node.log("queue.pause()", node.cmd);
                queue.pause();
                break;
              case 2:
                node.log("queue.resume()", node.cmd);
                queue.resume();
                break;
              default:
                node.log("queue.default()", node.cmd);
                break;
            }
          },
          function(error) {
            node.status({
              fill: "red",
              shape: "ring",
              text: "disconnected"
            });
          }
        );
*/
      });
    } catch (err) {
      // eg SyntaxError - which v8 doesn't include line number information
      // so we can't do better than this
      this.error(err);
    }

    this.on("close", function(removed, done) {
      if (node.bullConn) {
        node.brokerConn.deregister(node, done);
      }
    });
  }

  function BullQueueRunNode(n) {
    RED.nodes.createNode(this, n);
    var node = this;
    this.queue = n.queue;
    this.bullQueue = RED.nodes.getNode(this.queue);
    if (this.bullQueue) {
      this.status({
        fill: "red",
        shape: "ring",
        text: "node-red:common.status.disconnected"
      });
      this.bullQueue.register(node);
      var bullqueue = node.bullQueue.connect();
      if (bullqueue) {
        node.status({
          fill: "green",
          shape: "dot",
          text: "node-red:common.status.connected"
        });
      }
      bullqueue.process(function(job, completed) {
        node.log(JSON.stringify(job));
        node.send(job.data);
        completed();
      });
      /*
      node.Queue.connect().then(
        function(queue) {
          node.status({
            fill: "green",
            shape: "dot",
            text: "connected"
          });
          queue.process(function(job, completed) {
            node.log(JSON.stringify(job));
            node.send(job.data);
            completed();
          });
        },
        function(error) {
          node.status({
            fill: "red",
            shape: "ring",
            text: "disconnected"
          });
        }
      );
*/
    } else {
      node.error("common.status.error");
    }

    this.on("close", function(removed, done) {
      if (node.brokerConn) {
        node.deregister(node, done);
      }
      done();
    });
  }

  RED.nodes.registerType("bull cmd", BullQueueCmdNode);
  RED.nodes.registerType("bull run", BullQueueRunNode);
};
