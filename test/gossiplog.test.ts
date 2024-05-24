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
    let deleteDirectory: boolean = false;

    const directoryPath = path.join(__dirname, '../', 'test-data');
    beforeEach(async () => {
      gossiplogProcessManager = new GossipLogProcessManager();
      const config: NetworkConfig = [
        { name: 'a', peerId: await createEd25519PeerId(), port: 9990 },
        { name: 'b', peerId: await createEd25519PeerId(), port: 9991 },
      ];
      await gossiplogProcessManager.init(config);
    }, 20_000);

    afterEach(async () => {
      if (deleteDirectory) {
        if (fs.existsSync(directoryPath)) {
          await rimraf(directoryPath);
        }
      }
    });

    it.sequential(
      'Should track time taken to run a node for a long time with many entries',
      async () => {
        const connectedEntryInterval = 3000;
        const disconnectedEntryInterval = 1000;
        const totalEntriesToCreate = 200_000;

        await gossiplogProcessManager.startProcess('a');
        await gossiplogProcessManager.startProcess('b');
        for (let i = 0; i < totalEntriesToCreate; i += connectedEntryInterval + disconnectedEntryInterval) {
          const timeToCreate = await gossiplogProcessManager.createEntries('a', connectedEntryInterval);
          console.log(timeToCreate);
        }
      },
      100_000
    );
  },
  100_000
);
