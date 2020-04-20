var debug = require('debug')('pinza:cluster');
const kBucket = require('k-bucket');
const InterfaceDatastore = require('interface-datastore')
const {Key} = InterfaceDatastore
const multihash = require('multihashes')
const CID = require('cids')
const {default: PQueue} = require('p-queue');
const dagCbor = require('ipld-dag-cbor')

class Health {
    constructor(cluster) {

    }
    async get(cid) {

    }
}
class Pin {
    /**
     * 
     * @param {cluster} pinza 
     */
    constructor(cluster) {
        this.cluster = cluster;
        this.opQueue = new PQueue({concurrency: 1});
    }
    async add(cid, meta = {}, options) {
        cid = new CID(cid);
        var record = await this.cluster.collection.findOne({
            cid: cid.toString()
        })
        if(record) {
            throw `Pin with cid of ${cid.toString()} already exists`
        }
        await this.cluster.collection.insertOne({
            meta,
            cid: cid.toString(),
            type: "ipfs"
        })
    }
    async rm(cid, options) {
        cid = new CID(cid);
        await this.cluster.collection.findOneAndDelete({
            cid: cid.toString()
        })
    }
    async _add(cid) {
        debug(`pinning ${cid} to ipfs`)
        await this.cluster._ipfs.pin.add(cid);
        var object_info = await this.cluster._ipfs.object.stat(cid)
        delete object_info.Hash
        await this.cluster.datastore.put(`/commited/${pin}`, dagCbor.util.serialize({
            object_stat: object_info
        }))
    }
    async _rm(cid) {
        await this.cluster._ipfs.pin.rm(cid);
    }
    async currentCommitment() {
        var out = {};
        for await(var entry of this.cluster.datastore.query({prefix:"/commited", keysOnly: true})) {
            const {key} = entry;
            out[key.baseNamespace()] = {};
        }
        return out;
    }
    /**
     * 
     * @param {CID[]} commitment 
     */
    async setCommitment(commitment) {
        var currentCommitment = await this.currentCommitment()
        for(var pin of commitment) {
            if(!currentCommitment[pin.toString()]) {
                await this.cluster.datastore.put(`/commited/${pin}`, "")
                debug(`adding ${pin} to pinning queue`)
                this.opQueue.add(async() => await this._add(pin))
            }
        }
        for(var pin in currentCommitment) {
            if(!commitment.includes(pin.toString())) {
                debug(`removing ${pin} from commitment`)
                await this.cluster.datastore.delete(`/commited/${pin}`)
                this.opQueue.add(async() => await this._rm(pin))
            }
        }
        
    }
    async ls() {
        var pins = [];
        for await(var entry of this.cluster.datastore.query({pattern: "/pins"})) {
            var {key, value} = entry;
            pins.push(key.baseNamespace());
        }
        return pins;
    }
    async start() {
        this.collection = this.cluster.db.collection("pins")
    }
    async stop() {
        this.opQueue.pause()
        this.opQueue.clear()
    }
}
class Sharding {
    constructor(datastore, options = {}) {
        this.datastore = datastore;
        this.options = options;
        
        var {nodeId} = this.options;
        if(nodeId) {
            this.bucket = new kBucket({
                localNodeId: multihash.decode(multihash.fromB58String(nodeId)).digest,
                numberOfNodesPerKBucket: 500
            });
        } else {
            this.bucket = new kBucket({
                numberOfNodesPerKBucket: 500
            });
        }
    }
    async add(ipfsHash) {
        var cid = (new CID(ipfsHash)).toString();
        this._add(ipfsHash);
        debug(`Adding new ipfsHash to datastore: ${cid}`);
        await this.datastore.put(new Key(`pins/${cid}`), "");
    }
    _add(ipfsHash) {
        try {
            ipfsHash = (new CID(ipfsHash)).multihash
        } catch (ex) {
            return;
        }
        var mhash = multihash.decode(ipfsHash)
        this.bucket.add({
            id: mhash.digest,
            ipfsHash
        })
    }
    async del(ipfsHash) {
        var mhash = multihash.decode(ipfsHash)
        this.bucket.remove(mhash.digest);
        await this.datastore.del(new Key(`${mhash.toString()}`), "");
    }
    reset() {
        delete this.bucket;
        var {nodeId} = this.options;
        if(nodeId) {
            this.bucket = new kBucket({
                localNodeId: multihash.decode(multihash.fromB58String(nodeId)).digest,
                numberOfNodesPerKBucket: 500
            });
        } else {
            this.bucket = new kBucket({
                numberOfNodesPerKBucket: 500
            });
        }
    }
    /**
     * Generates list of CIDs that this node is responsible for storing.
     * @param {Number} replication_factor 
     * @param {Number} nNodes
     * @returns {CID[]}
     */
    myCommitment(replication_factor = 1, nNodes = 1) {
        var count = this.count();
        var allocated = Math.round((count/nNodes)*replication_factor);
        if(allocated === 0) {
            allocated = 1;
        }
        var out = [];
        for(var pin of this.bucket.closest(this.bucket.localNodeId, allocated)) {
            out.push(multihash.toB58String(pin.ipfsHash))
        }
        return out;
    }
    count() {
        return this.bucket.count()
    }
    async start() {
        debug("loading datastore")
        for await(var entry of this.datastore.query({pattern:"/pins", keysOnly: true})) {
            const {key, value} = entry;
            this._add(key.baseNamespace())
        }
    }
    async stop() {
        
    }
}
class Cluster {
    /**
     * 
     * @param {*} ipfs 
     * @param {} db 
     * @param {*} config 
     * @param {InterfaceDatastore.MemoryDatastore} datastore 
     */
    constructor(ipfs, db, config, datastore) {
        this._ipfs = ipfs;
        
        this.db = db;
        this.config = config;
        this.datastore = datastore;
        this.pin = new Pin(this);
        this.sharding = new Sharding(datastore);
    }
    get id() {
        return this.db.address;
    }
    get address() {
        return this.db.address.toString()
    }
    async start() {
        await this.sharding.start();
        this.collection = this.db.collection("pins")

        //Reindex every 60 seconds
        this.reindex_pid = setInterval(async() => {
            debug(`Querying datastore for changes`);
            var result = await this.collection.distinct("cid")
            this.sharding.reset()
            result.forEach(item => {
                this.sharding.add(item)
            })
            this.pin.setCommitment(this.sharding.myCommitment())
        }, 60000);
    }
    async stop() {
        this.pin.stop();
        await this.db.close();
        clearInterval(this.reindex_pid)
        await this.sharding.stop()
    }
    async init() {
        //Later use
    }
    static async open(ipfs, orbitdb, address) {

    }
}
Cluster.Sharding = Sharding
module.exports = Cluster;
