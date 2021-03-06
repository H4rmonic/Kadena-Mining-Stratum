var Stratum = require('stratum-pool');
var redis = require('redis');
var net = require('net');

var MposCompatibility = require('./mposCompatibility.js');

module.exports = function (logger) {

    var _this = this;

    var poolConfigs = JSON.parse(process.env.pools);
    var portalConfig = JSON.parse(process.env.portalConfig);

    var forkId = process.env.forkId;

    var pools = {};

    var proxySwitch = {};

    var redisClient = redis.createClient(portalConfig.redis.port, portalConfig.redis.host);
    if (portalConfig.redis.password) {
        redisClient.auth(portalConfig.redis.password);
    }
    //Handle messages from master process sent via IPC
    process.on('message', function (message) {
        switch (message.type) {

            case 'banIP':
                for (var p in pools) {
                    if (pools[p].stratumServer)
                        pools[p].stratumServer.addBannedIP(message.ip);
                }
                break;

            case 'blocknotify':

                var messageCoin = message.coin.toLowerCase();
                var poolTarget = Object.keys(pools).filter(function (p) {
                    return p.toLowerCase() === messageCoin;
                })[0];

                if (poolTarget)
                    pools[poolTarget].processBlockNotify(message.hash, 'blocknotify script');

                break;

            // IPC message for pool switching
            case 'coinswitch':
                var logSystem = 'Proxy';
                var logComponent = 'Switch';
                var logSubCat = 'Thread ' + (parseInt(forkId) + 1);

                var switchName = message.switchName;

                var newCoin = message.coin;

                var algo = poolConfigs[newCoin].coin.algorithm;

                var newPool = pools[newCoin];
                var oldCoin = proxySwitch[switchName].currentPool;
                var oldPool = pools[oldCoin];
                var proxyPorts = Object.keys(proxySwitch[switchName].ports);

                if (newCoin == oldCoin) {
                    logger.debug(logSystem, logComponent, logSubCat, 'Switch message would have no effect - ignoring ' + newCoin);
                    break;
                }

                logger.debug(logSystem, logComponent, logSubCat, 'Proxy message for ' + algo + ' from ' + oldCoin + ' to ' + newCoin);

                if (newPool) {
                    oldPool.relinquishMiners(
                        function (miner, cback) {
                            // relinquish miners that are attached to one of the "Auto-switch" ports and leave the others there.
                            cback(proxyPorts.indexOf(miner.client.socket.localPort.toString()) !== -1)
                        },
                        function (clients) {
                            newPool.attachMiners(clients);
                        }
                    );
                    proxySwitch[switchName].currentPool = newCoin;

                    redisClient.hset('proxyState', algo, newCoin, function (error, obj) {
                        if (error) {
                            logger.error(logSystem, logComponent, logSubCat, 'Redis error writing proxy config: ' + JSON.stringify(err))
                        }
                        else {
                            logger.debug(logSystem, logComponent, logSubCat, 'Last proxy state saved to redis for ' + algo);
                        }
                    });

                }
                break;

            case 'getMinerCount':
                var minerCount = 0;
                for (var p in pools) {
                    if (pools[p].stratumServer) {
                        minerCount += pools[p].getTotalMinerCount();
                    }
                }
                process.send({ type: 'minerCount', minerCount: minerCount });
                break;
        }
    });


    Object.keys(poolConfigs).forEach(function (coin) {

        var poolOptions = poolConfigs[coin];
        const stratum_id = portalConfig.defaultPoolConfigs.stratum_id;


        var logSystem = 'Pool';
        var logComponent = coin;
        var logSubCat = 'Thread ' + (parseInt(forkId) + 1);

        var handlers = {
            auth: function () { },
            share: function () { },
            diff: function () { },
            disconnect: function () { }
        };

        //Functions required for MPOS compatibility
        if (poolOptions.mposMode && poolOptions.mposMode.enabled) {
            var mposCompat = new MposCompatibility(logger, poolOptions);

            handlers.auth = function (ip, version, port, workerName, password, authCallback) {
                mposCompat.handleAuth(stratum_id, ip, version, port, workerName, password, authCallback);
            };

            handlers.share = function (isValidShare, isValidBlock, data) {
                mposCompat.handleShare(isValidShare, isValidBlock, data);
            };

            handlers.diff = function (workerName, diff, iceWorkerId) {
                mposCompat.handleDifficultyUpdate(workerName, diff, iceWorkerId);
            }

            //      _this.emit('socketDisconnect', _this.iceWorkerId, _this.workerName, _this.uuid);

            handlers.disconnect = function (workerId, workerName, uuid) {
                //console.log("disconnect 2 workerId " + workerId + " workerName " + workerName + " uuid " + uuid)
                mposCompat.handleDisconnect(workerId, workerName, uuid);
            }

        }

        //Functions required for internal payment processing
        else {
            handlers.auth = function (ip, version, port, workerName, password, authCallback) {
                if (poolOptions.validateWorkerUsername !== true)
                    authCallback(true);
                else {
                    workerName = workerName.replace(/([_.!~*'()].*)/g, ''); // strip any extra strings from worker name.
                    console.log("handlers.auth poolWorker");
                    pool.daemon.cmd('validateaddress', [String(workerName).split(".")[0]], function (results) {
                        var isValid = results.filter(function (r) {
                            return r.response.isvalid
                        }).length > 0;
                        authCallback(isValid);
                    });
                }
            };

            // handlers.share = function(isValidShare, isValidBlock, data){
            //     shareProcessor.handleShare(isValidShare, isValidBlock, data);
            //  };
        }

        var authorizeFN = function (ip, version, port, workerName, password, callback) {
            //  console.log(`poolWorker authorizeFN ip ${ip} version ${version} port ${port} worker ${workerName} pass ${password}`);

            handlers.auth(ip, version, port, workerName, password, function (authorized, results) {

                var authString = authorized ? 'Authorized' : 'Unauthorized ';

                logger.debug(logSystem, logComponent, logSubCat, authString + ' ' + workerName + ':' + password + ' [' + ip + ']');
                callback({
                    uuid: results.uuid,
                    error: null,
                    authorized: authorized,
                    disconnect: false,
                    iceWorkerId: results.iceWorkerId,
                    iceUserId: results.iceUserId,
                    iceCoinId: results.iceCoinId,
                    difficulty: results.difficulty,
                    mode: results.mode,
                    party_pass: results.party_pass
                });
            });
        };


        var pool = Stratum.createPool(poolOptions, authorizeFN, logger);
        pool.on('share', function (isValidShare, isValidBlock, data, iceUserId, iceCoinId) {

            var shareData = JSON.stringify(data);

            if (data.blockHash && !isValidBlock)
                logger.debug(logSystem, logComponent, logSubCat, 'We thought a block was found but it was rejected by the daemon, share data: ' + shareData);

            else if (isValidBlock)
                logger.debug(logSystem, logComponent, logSubCat, 'Block found: ' + data.blockHash + ' by ' + data.worker);

            if (isValidShare) {
                if (data.shareDiff > 1000000000) {
                    logger.debug(logSystem, logComponent, logSubCat, 'Share was found with diff higher than 1.000.000.000!');
                } else if (data.shareDiff > 1000000) {
                    logger.debug(logSystem, logComponent, logSubCat, 'Share was found with diff higher than 1.000.000!');
                }
                //logger.debug(logSystem, logComponent, logSubCat, 'Share accepted at diff ' + data.difficulty + '/' + data.shareDiff + ' by ' + data.worker + ' [' + data.ip + ']' );
            } else if (!isValidShare) {
                logger.debug(logSystem, logComponent, logSubCat, 'Share rejected: ' + shareData);
            }

            // handle the share
            handlers.share(isValidShare, isValidBlock, data);

        }).on('difficultyUpdate', function (workerName, diff, iceWorkerId) {
            //logger.debug(logSystem, logComponent, logSubCat, 'Difficulty update to diff ' + diff + ' workerName=' + JSON.stringify(workerName));
            handlers.diff(workerName, diff, iceWorkerId);
        }).on('minerDisconnect', function (iceWorkerId, workerName, uuid) {
            //logger.debug(logSystem, logComponent, logSubCat, 'Miner disconnected: ' + iceWorkerId);
            handlers.disconnect(iceWorkerId, workerName, uuid);
        }).on('log', function (severity, text) {
            switch (severity) {
                case 'info':
                    logger.info(logComponent, text);
                    break;
                case 'warning':
                    logger.warn(logComponent, text);
                    break;
                case 'error':
                    logger.error(logComponent, text);
                    break;
                default:
                    logger.info(logComponent, text);
                    break;
            };
            // logger[severity](logSystem, logComponent, logSubCat, text);
        }).on('banIP', function (ip, worker) {
            process.send({ type: 'banIP', ip: ip });
        }).on('started', function () {
            //_this.setDifficultyForProxyPort(pool, poolOptions.coin.name, poolOptions.coin.algorithm);
        });

        pool.start();
        pools[poolOptions.coin.name] = pool;
    });




    this.getFirstPoolForAlgorithm = function (algorithm) {
        var foundCoin = "";
        Object.keys(poolConfigs).forEach(function (coinName) {
            if (poolConfigs[coinName].coin.algorithm == algorithm) {
                if (foundCoin === "")
                    foundCoin = coinName;
            }
        });
        return foundCoin;
    };

};

