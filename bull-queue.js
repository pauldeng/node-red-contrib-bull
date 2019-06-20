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
	var q = require('q');
	var util = require("util");
	var vm = require("vm");
	var child_process = require('child_process');
	var request = require('request');
	var Queue = require("bull");

	function BullQueueServerSetup(config) {
		RED.nodes.createNode(this, config);

		this.connected = false;
		this.connecting = false;
		this.usecount = 0;
		// Config node state
		this.name = config.name;
		this.address = config.address;
		this.port = config.port;

		var node = this;
		this.register = function() {
			node.usecount += 1;
		};

		this.deregister = function() {
			node.usecount -= 1;
			if (node.usecount == 0) {
			}
		};

		this.connect = function() {
			var deferred = q.defer();
			if (!node.connected && !node.connecting) {
				node.connecting = true;
				node.queue = Queue(node.name, node.port, node.address);
				node.log("connected", {
					server : (node.address ? node.address + "@" : "") + node.port
				});
				node.connecting = false;
				node.connected = true;
				node.emit('connected');
				deferred.resolve(node.queue);
			} else {
				if (node.queue) {
					deferred.resolve(node.queue);
				}
			}
			return deferred.promise;
		};

		this.on('close', function(removed, closecomplete) {
			if (removed){
				// This node has been deleted
			} else {
				// This node is being restarted
			}
			node.Queue.close();
			node.log("closed");
			closecomplete()
		});
	}


	RED.nodes.registerType("bull-queue-server", BullQueueServerSetup);

	function BullQueueCmdNode(config) {
		RED.nodes.createNode(this, config);
		var node = this;
		this.name = config.name;
		this.queue = config.queue;
		this.cmd = config.cmd;
		this.Queue = RED.nodes.getNode(this.queue);
		if (node.Queue) {
			node.Queue.register();
			node.Queue.connect().then(function(queue) {
				node.status({
					fill : "green",
					shape : "dot",
					text : "connected"
				});
			}, function(error) {
				node.status({
					fill : "red",
					shape : "ring",
					text : "disconnected"
				});
			});
		} else {
			node.error("common.status.error");
		}
		try {
			this.on("input", function(msg) {
				node.Queue.connect().then(function(queue) {
					switch (parseInt(node.cmd)) {
					case 0:
						node.log("queue.add({payload:" + msg.payload + "}, " + JSON.stringify(msg.jobopts) + ")");
						async function add(msg){
							return await queue.add(
								{payload: msg.payload},
								msg.jobopts);
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
				}, function(error) {
					node.status({
						fill : "red",
						shape : "ring",
						text : "disconnected"
					});
				});
			});
		} catch(err) {
			// eg SyntaxError - which v8 doesn't include line number information
			// so we can't do better than this
			this.error(err);
		};

		this.on('close', function(removed, done) {
			if (removed) {
				// This node has been deleted
			} else {
				// This node is being restarted
			}
			node.Queue.close();
			done();
		});
	}

	function BullQueueRunNode(config) {
		RED.nodes.createNode(this, config);
		var node = this;
		this.name = config.name;
		this.func = config.func;
		this.queue = config.queue;
		this.timeout = config.timeout;
		this.Queue = RED.nodes.getNode(this.queue);
		if (node.Queue) {
			node.Queue.register();
			node.Queue.connect().then(function(queue) {
				node.status({
					fill : "green",
					shape : "dot",
					text : "connected"
				});
				queue.process(function(job, completed) {
					node.log(JSON.stringify(job));
					node.send(job.data);
					completed();
				});
			}, function(error) {
				node.status({
					fill : "red",
					shape : "ring",
					text : "disconnected"
				});
			});
		} else {
			node.error("common.status.error");
		};

		this.on('close', function(removed, done) {
			if (removed) {
				// This node has been deleted
			} else {
				// This node is being restarted
			}
			node.Queue.close();
			done();
		});
	}


	RED.nodes.registerType("bull cmd", BullQueueCmdNode);
	RED.nodes.registerType("bull run", BullQueueRunNode);
};
