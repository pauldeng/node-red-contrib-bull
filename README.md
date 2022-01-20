# node-red-contrib-bull

![Version](https://img.shields.io/badge/version-0.0.1-blue.svg?cacheSeconds=2592000)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/pauldeng/node-red-contrib-bull/blob/master/LICENSE)

> A powerful job queue nodes for Node-RED.

This repo is not in production quality. I use it primirarly for bulls repeatble jobs and I do not implement and test other functions. Pull Request welcome.  
This repo is forked from [node-red-contrib-job-queue](https://github.com/cuongquay/node-red-contrib-job-queue) but with comperhensive changes. The changes are:

- updated bull to 4.2.1
- removed the function in queue-run node
- removed the Command drop down box from queue-cmd node, this node accepts new command from msg input
- rename and icon

## Install

```sh
sudo apt install redis
cd ~/.node-red
npm install https://github.com/pauldeng/node-red-contrib-bull.git
```

## Run Example

1. copy the content within examples/example_flow.json
2. paste it into Node-Red import Clipboard
3. click inject node to "simple", it will add job to bull queue. Debug node linked to bull run will print the payload.
4. click inject node to "add cron job", it will add cron job to bull queue. Debug node linked to bull run will print the payload every 10 seconds
5. click inject node to "getRepeatableJobs", it will retrivev all repeatable jobs. Debug node will print all repeatable jobs in msg.payload
6. click inject node to "count", it will count all repeatable jobs. Debug node will print the total number of repeatable jobs in msg.payload
7. click inject node to "removeRepeatableByKey", it delete the repeatable job which contains msg.jobid.
8. click inject node to "stopAndRemoveAllJobs", it delete all repeatable job.

## Development

```sh
sudo apt install redis
cd
git clone https://github.com/pauldeng/node-red-contrib-bull.git
cd node-red-contrib-bull
npm link
cd ~/.node-red
npm link node-red-contrib-bull
# make code changes and restart node-red to test
```

## Roadmap

- [ ] Node connection status
- [ ] Reconnect status

## Author

👤 **Paul Deng**

- Twitter: [@pauldeng](https://twitter.com/pauldeng)
- Github: [@pauldeng](https://github.com/pauldeng)

## 📝 License

Copyright © 2022 [Paul Deng](https://github.com/pauldeng).

This project is [MIT](https://github.com/pauldeng/node-red-contrib-bull/blob/master/LICENSE) licensed.

---
