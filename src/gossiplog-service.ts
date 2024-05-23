import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { EventHandler, Libp2p, PeerId, PubSub } from "@libp2p/interface";
import { plaintext } from "@libp2p/plaintext";
import { tcp } from "@libp2p/tcp";
import { createLibp2p } from "libp2p";
import { GossipLogService, GossipLogServiceInit, gossiplog } from "@canvas-js/gossiplog/service"
import path from 'path';
import { createEd25519PeerId } from '@libp2p/peer-id-factory';
import { GossipLog } from "@canvas-js/gossiplog/node";
import { rimraf } from "rimraf";
import { exec } from 'child_process';
import { promisify } from 'util'; 
import { Environment } from '@canvas-js/okra-node';
import fs from 'fs';
import logger from 'debug';
import { bootstrap } from "@libp2p/bootstrap";
import pDefer, { DeferredPromise } from "p-defer"
import { Message, Signature } from "@canvas-js/interfaces"
import { GossipLogEvents } from "@canvas-js/gossiplog";
import { mplex } from "@libp2p/mplex";

const TOPIC = 'test.gossiplog'

export type NetworkInit = Record<string, { port: number; peers: string[]; init?: GossipLogServiceInit }>

const getAddress = (port: number) => `/ip4/127.0.0.1/tcp/${port}`

export type ServiceMap = {
	identify: {}
	pubsub: PubSub
	gossiplog: GossipLogService
}

export async function createNetwork(
	networkInit: NetworkInit,
	options: { start?: boolean; minConnections?: number; maxConnections?: number } = {},
): Promise<Record<string, Libp2p<ServiceMap>>> {
	const names = Object.keys(networkInit)

	const peerIds = await Promise.all(
		names.map<Promise<[string, PeerId]>>(async (name) => {
			const peerId = await createEd25519PeerId()
			return [name, peerId]
		}),
	).then((entries) => Object.fromEntries(entries))

	const log = logger("canvas:gossiplog:test")

	const network: Record<string, Libp2p<ServiceMap>> = await Promise.all(
		Object.entries(networkInit).map(async ([name, { port, peers, init }]) => {
			const peerId = peerIds[name]
			const address = getAddress(port)
			const bootstrapList = peers.map(
				(peerName) => `${getAddress(networkInit[peerName].port)}/p2p/${peerIds[peerName]}`,
			)

			const minConnections = options.minConnections ?? peers.length
			const maxConnections = options.maxConnections ?? peers.length + 1

			const libp2p = await createLibp2p({
				peerId: peerId,
				start: false,
				addresses: { listen: [address] },
				transports: [tcp()],
				connectionEncryption: [plaintext()],
				streamMuxers: [mplex()],
				peerDiscovery: bootstrapList.length > 0 ? [bootstrap({ list: bootstrapList, timeout: 0 })] : [],
				connectionManager: { minConnections, maxConnections, autoDialInterval: 1000 },

				services: {
					identify: identify({ protocolPrefix: "canvas" }),

					pubsub: gossipsub({
						emitSelf: false,
						fallbackToFloodsub: false,
						allowPublishToZeroPeers: true,
						globalSignaturePolicy: "StrictSign",
					}),

					gossiplog: gossiplog(init ?? {}),
				},
			})

			libp2p.addEventListener("start", () => log("[%p] started", peerId))

			libp2p.addEventListener("transport:listening", ({ detail: listener }) => {
				const addrs = listener.getAddrs().map((addr) => addr.toString())
				log("[%p] listening on", peerId, addrs)
			})

			libp2p.addEventListener("peer:discovery", ({ detail: peerInfo }) =>
				log("[%p] discovered peer %p", peerId, peerInfo.id),
			)

			libp2p.addEventListener("peer:connect", ({ detail }) => {
				log("[%p] connected to peer %p", peerId, detail)
			})

			return [name, libp2p]
		}),
	).then((entries) => Object.fromEntries(entries))

	if (options.start ?? true) {
		await Promise.all(Object.values(network).map((libp2p) => libp2p.start()))
	}

	return network
}

export async function waitForInitialConnections(
	network: Record<string, Libp2p<ServiceMap>>,
	options: { minConnections?: number } = {},
): Promise<void> {
	const minConnections = options.minConnections ?? Object.keys(network).length - 1

	const connectionCounts: Record<string, Set<string>> = {}
	const connectionPromises: Record<string, DeferredPromise<void>> = {}

	for (const libp2p of Object.values(network)) {
		const sourceId = libp2p.peerId.toString()
		connectionCounts[sourceId.toString()] = new Set()
		connectionPromises[sourceId] = pDefer()
		libp2p.addEventListener("peer:connect", (event) => {
			const targetId = event.detail.toString()
			connectionCounts[sourceId].add(targetId)
			if (connectionCounts[sourceId].size >= minConnections) {
				connectionPromises[sourceId].resolve()
			}
		})
	}

	await Promise.all(Object.values(connectionPromises).map((defer) => defer.promise))
}

type Result = { id: string; signature: Signature; message: Message }
export async function waitForMessageDelivery(
	network: Record<string, Libp2p<ServiceMap>>,
	match: (id: string, signature: Signature, message: Message) => boolean,
): Promise<Result> {
	const results = await Promise.all(
		Object.entries(network).map(([name, libp2p]) => {
			const peerId = libp2p.peerId.toString()
			const deferred = pDefer<Result>()
			const handler: EventHandler<GossipLogEvents<unknown>["message"]> = ({ detail: { id, signature, message } }) => {
				if (match(id, signature, message)) {
					deferred.resolve({ id, signature, message })
				}
			}

			libp2p.services.gossiplog.addEventListener("message", handler)
			return deferred.promise.finally(() => libp2p.services.gossiplog.removeEventListener("message", handler))
		}),
	)

	return results[0]
}


export type ReplicatedObject = {
  id: string;
}

function createReplicatedObject(): ReplicatedObject {
  return { id: crypto.randomUUID() };
}
function validateReplicatedObject(payload: unknown): payload is ReplicatedObject {
  if (typeof payload === 'object' && payload !== null) {
    const p = payload as ReplicatedObject;
    return typeof p.id === 'string'; 
  }
  return false;
}

async function runGossipLogTest(numberOfConnectedAppendOps: number, numberOfDisconnectedAppendOps: number): Promise<void> {
  if (fs.existsSync(path.join(__dirname, 'test-data', '1'))) {
    await rimraf(path.join(__dirname, 'test-data', '1'))
  }
  fs.mkdirSync(path.join(__dirname, 'test-data', '1'), { recursive: true });


  if (fs.existsSync(path.join(__dirname, 'test-data', '2'))) {
    await rimraf(path.join(__dirname, 'test-data', '2'))
  }
  fs.mkdirSync(path.join(__dirname, 'test-data', '2'), { recursive: true });


  const network = await createNetwork({
    a: { port: 9990, peers: ["b"], init: { sync: true } },
    b: { port: 9991, peers: ["a"], init: { sync: true } },
  });
  await waitForInitialConnections(network);

  const environment1 = new Environment(path.join(__dirname, 'test-data', '1'), { databases: 3, mapSize: 5_000_000_000 });
  const gossipLog1: GossipLog<ReplicatedObject, void> = new GossipLog(environment1, { topic: TOPIC, apply: () => {}, validate: validateReplicatedObject });
  await gossipLog1.write(async (txn) => {})

  const environment2 = new Environment(path.join(__dirname, 'test-data', '2'), { databases: 3, mapSize: 5_000_000_000 });
  const gossipLog2: GossipLog<ReplicatedObject, void> = new GossipLog(environment2, { topic: TOPIC, apply: () => {}, validate: validateReplicatedObject });
  await gossipLog2.write(async (txn) => {})

  const missingObjectsLog1 = new Set();
  const missingObjectsLog2 = new Set();

  gossipLog1.addEventListener('message', (message) => { 
    missingObjectsLog1.delete(message.detail.message.payload.id) 
  });
  gossipLog2.addEventListener('message', (message) => { 
    missingObjectsLog2.delete(message.detail.message.payload.id) 
  });

  await Promise.all([network.a.services.gossiplog.subscribe(gossipLog1), network.b.services.gossiplog.subscribe(gossipLog2)]);

  for (let i = 1; i < numberOfConnectedAppendOps + 1; i++) {
    const object = createReplicatedObject();

    // Randomly create objects between the nodes.
    try {
      if (Math.random() < 0.5) {
        missingObjectsLog2.add(object.id);
        await network['a'].services.gossiplog.append(TOPIC, object);
      } else {
        missingObjectsLog1.add(object.id);
        await network['b'].services.gossiplog.append(TOPIC, object);
      }
      await delay(10);
      if (i % 1000 === 0) {
        console.log(`Appended ${i} entries`);
      }
    } catch (error) {
      console.error((error as Error).stack);
      console.log(`Got max entries: ${i}`)
    }
  }

  console.log(`Finished creating all the entries. Waiting for replication of entries to finish.`)

  // Wait for the objects to be replicated between the nodes
  await waitForCondition(() => missingObjectsLog1.size + missingObjectsLog2.size === 0);

  console.log(`Blocking port connections.`)
  // // Now, we will disconnect the nodes and start creating a ton of messages that will need to be synced later
  await blockPortConnection(9990);
  await blockPortConnection(9991);

  for (let i = 1; i < numberOfDisconnectedAppendOps + 1; i++) {
    const object = createReplicatedObject();

    missingObjectsLog2.add(object.id);

    await network['a'].services.gossiplog.append(TOPIC, object);

    await delay(10);
    
    if (i % 1000 === 0) {
      console.log(`Created ${i} objects - after disconnect`)
    }
  }

  console.log(`Unblocking ports`)
  await Promise.all([unblockPortConnection(9990), unblockPortConnection(9991)]);

  const start = performance.now();
  console.log(`Waiting for trees to merge diffs`)
  await waitForCondition(() => missingObjectsLog1.size + missingObjectsLog2.size === 0);
  const end = performance.now();
  console.log(`Catching nodes back up took ${(end - start)} milliseconds`);

  // await rimraf(path.join(__dirname, 'test-data', '1'))
  // await rimraf(path.join(__dirname, 'test-data', '2'))
}

runGossipLogTest(5_000, 10_000).then(() => process.exit(0));

function waitForCondition(conditionFn: () => boolean, checkInterval = 10) {
  return new Promise<void>((resolve, reject) => {
    const interval = setInterval(() => {
      try {
        if (conditionFn()) {
          clearInterval(interval);
          resolve();
        }
      } catch (error) {
        clearInterval(interval);
        reject(error);
      }
    }, checkInterval);
  });
}

async function blockPortConnection(port: number) {
  try {
  const blockInboundCommand = `sudo iptables -A INPUT -p tcp --dport ${port} -j DROP`;
  const blockOutboundCommand = `sudo iptables -A OUTPUT -p tcp --dport ${port} -j DROP`;
  await promisify(exec)(blockInboundCommand);
  await promisify(exec)(blockOutboundCommand);
  } catch (error) {
    console.log(error);
  }
}

async function unblockPortConnection(port: number) {
  try {
  const unblockInboundCommand = `sudo iptables -D INPUT -p tcp --dport ${port} -j DROP`;
  const unblockOutboundCommand = `sudo iptables -D OUTPUT -p tcp --dport ${port} -j DROP`;
  await promisify(exec)(unblockInboundCommand);
  await promisify(exec)(unblockOutboundCommand);
  } catch (error) {
    console.log(error);
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(() => resolve(), ms));
}
