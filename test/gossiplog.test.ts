import { describe, it, afterEach, beforeEach } from 'vitest';
import { GossipLogProcessManager, NetworkConfig } from '../src/gossiplog-process-manager';
import { createEd25519PeerId } from '@libp2p/peer-id-factory';
import fs from 'fs';
import path from 'path';
import { rimraf } from 'rimraf';

/**
 * Tests that I need to cover for the GossipLog
 * 1. Run the test over a long period of time. Connect the nodes, create 2_000 entries on one, wait for them to replicate.
 * Then, disconnect them, create 1000 entries on one node, and then connect them. See how long it takes to catch up
 * the nodes over time as we have more entries stored over time.
 *
 * 2. Check the data size of the POJO vs what's stored in the database.
 *
 * 3. Check the startup times where nodes already have n number of entries in them, and we add 50 new entries. See how long it takes for
 * the entries to be added and replicated.
 */

describe.sequential(
  'GossipLog stress tests',
  async () => {
    let gossiplogProcessManager: GossipLogProcessManager;
    let deleteTestDataDirectory: boolean = false;
    let deletePerformanceDataDirectory: boolean = false;

    const testDataDirectoryPath = path.join(__dirname, '../test', 'test-data');
    const performanceDataDirectoryPath = path.join(__dirname, '../test', 'performance-data');
    beforeEach(async () => {
      if (fs.existsSync(testDataDirectoryPath)) {
        await rimraf(testDataDirectoryPath);
      }
      gossiplogProcessManager = new GossipLogProcessManager();
    }, 20_000);

    afterEach(async () => {
      if (deleteTestDataDirectory) {
        if (fs.existsSync(testDataDirectoryPath)) {
          await rimraf(testDataDirectoryPath);
        }
      }
    });

    it.sequential(
      'Should fail to replicate when catching up 10s of thousands of entries',
      async () => {
        const config: NetworkConfig = [
          { name: 'a', peerId: await createEd25519PeerId(), port: 9990 },
          { name: 'b', peerId: await createEd25519PeerId(), port: 9991 },
        ];
        gossiplogProcessManager.logOutputBasePath = path.join(__dirname, 'logs', 'catch-up-entries-test');
        await gossiplogProcessManager.init(config);

        await gossiplogProcessManager.startProcess('a');
        await gossiplogProcessManager.startProcess('b');

        await gossiplogProcessManager.createEntries('a', 20_000);
        await gossiplogProcessManager.waitForReplicationToFinish('b');

        console.log('Created 20_000 initial entries');

        await gossiplogProcessManager.blockPortConnection('a');
        await gossiplogProcessManager.blockPortConnection('b');

        await new Promise<void>(resolve => setTimeout(() => resolve(), 1_000));

        await gossiplogProcessManager.createEntries('a', 35_000);

        console.log('Created 35_000 entries while disconnected');

        await gossiplogProcessManager.unblockPortConnection('a');
        await gossiplogProcessManager.unblockPortConnection('b');
        console.log('Reconnected...trying to replicate entries');

        await new Promise<void>(resolve => setTimeout(() => resolve(), 1_000_000_000));
        console.log('Replicated entries');
      },
      Infinity
    );

    it.sequential(
      'Should track time taken to run a node for a long time with many entries',
      async () => {
        const config: NetworkConfig = [
          { name: 'a', peerId: await createEd25519PeerId(), port: 9990 },
          { name: 'b', peerId: await createEd25519PeerId(), port: 9991 },
        ];
        gossiplogProcessManager.logOutputBasePath = path.join(__dirname, 'logs', 'long-run-data');
        await gossiplogProcessManager.init(config);

        const connectedEntryInterval = 3000;
        const disconnectedEntryInterval = 1000;
        const totalEntriesToCreate = 1_000_000;

        const numberOfEntriesToTimeTakenToSync: [number, number][] = [];
        await gossiplogProcessManager.startProcess('a');
        await gossiplogProcessManager.startProcess('b');
        for (let i = 0; i < totalEntriesToCreate; i += connectedEntryInterval + disconnectedEntryInterval) {
          await gossiplogProcessManager.createEntries('a', connectedEntryInterval);
          console.log(`Created ${i + connectedEntryInterval} entries`);
          await gossiplogProcessManager.waitForReplicationToFinish('b');
          console.log(`Replication of created entries finished`);
          await gossiplogProcessManager.blockPortConnection('a');

          await gossiplogProcessManager.createEntries('a', disconnectedEntryInterval);
          await gossiplogProcessManager.unblockPortConnection('a');
          const timeToCatchUp = await gossiplogProcessManager.waitForReplicationToFinish('b');
          console.log(timeToCatchUp);
          numberOfEntriesToTimeTakenToSync.push([connectedEntryInterval + disconnectedEntryInterval, timeToCatchUp]);
        }

        const outFilePath = path.join(performanceDataDirectoryPath, 'long-run-test.json');
        if (!fs.existsSync(outFilePath)) {
          fs.appendFileSync(outFilePath, JSON.stringify(numberOfEntriesToTimeTakenToSync));
        }
      },
      Infinity
    );
  },
  Infinity
);
