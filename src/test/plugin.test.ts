import { expect, it, describe, beforeEach, afterEach, vi } from 'vitest';
import utils from '@eventcatalog/sdk';
import plugin from '../index';
import { join } from 'node:path';
import fs from 'fs/promises';
import {
  DescribeSchemaCommand,
  DescribeSchemaCommandOutput,
  ExportSchemaCommand,
  ListSchemasCommand,
  SchemasClient,
} from '@aws-sdk/client-schemas';
import { existsSync } from 'node:fs';

const setupMocks = () => {
  // Mock the entire @aws-sdk/client-schemas module
  vi.mock('@aws-sdk/client-schemas', () => {
    return {
      SchemasClient: vi.fn(() => ({
        send: vi.fn((command) => {
          if (command instanceof ListSchemasCommand) {
            return Promise.resolve({
              Schemas: [
                { SchemaName: 'myapp.users@UserSignedUp', VersionCount: 1 },
                { SchemaName: 'myapp.users@UserLoggedIn', VersionCount: 3 },
                { SchemaName: 'myapp.orders@OrderPlaced', VersionCount: 10 },
              ],
            });
          }
          if (command instanceof ExportSchemaCommand) {
            return Promise.resolve({
              Content: JSON.stringify({
                type: 'object',
                properties: {
                  detail: {
                    type: 'object',
                    properties: {
                      key1: { type: 'string' },
                      key2: { type: 'number' },
                    },
                  },
                },
              }),
            });
          }
          if (command instanceof DescribeSchemaCommand) {
            return Promise.resolve({
              Content: JSON.stringify({
                openapi: '3.0.0',
                info: { title: 'Test Schema', version: '1.0.0' },
                paths: {},
              }),
              SchemaVersion: '1',
              LastModified: new Date('2023-01-01'),
            } as DescribeSchemaCommandOutput);
          }
          return Promise.reject(new Error('Command not mocked'));
        }),
      })),
      DescribeSchemaCommand: vi.fn(),
      ListSchemasCommand: vi.fn(),
      ExportSchemaCommand: vi.fn(),
    };
  });
};

// Fake eventcatalog config
const config = {
  title: 'My EventCatalog',
};

let catalogDir: string;

describe('EventBridge EventCatalog Plugin', () => {
  beforeEach(async () => {
    // if it exists, remove it
    if (existsSync(join(__dirname, 'catalog'))) {
      await fs.rm(join(__dirname, 'catalog'), { recursive: true });
    }
    catalogDir = join(__dirname, 'catalog') || '';
    process.env.PROJECT_DIR = catalogDir;
    // vi.clearAllMocks();
    setupMocks();
    // Set up the mock SchemasClient
    // mockSchemasClient = new SchemasClient({});
  });

  afterEach(async () => {
    await fs.rm(join(catalogDir), { recursive: true });
  });

  describe('domains', () => {
    it('if a domain is defined in the EventBridge generator and it does not exist it is created and the service is mapped to the domain', async () => {
      const { getDomain } = utils(catalogDir);

      await plugin(config, {
        region: 'us-east-1',
        registryName: 'discovered-schemas',
        services: [{ id: 'Orders Service', version: '1.0.0' }],
        domain: { id: 'orders', name: 'Orders Domain', version: '1.0.0' },
      });

      const domain = await getDomain('orders', '1.0.0');

      expect(domain).toEqual({
        id: 'orders',
        name: 'Orders Domain',
        version: '1.0.0',
        services: [{ id: 'Orders Service', version: '1.0.0' }],
        markdown: expect.any(String),
      });
    });

    it('if a domain is defined in the EventBridge generator but the versions do  not match, the existing domain is versioned and a new one is created', async () => {
      const { writeDomain, getDomain } = utils(catalogDir);

      await writeDomain({
        id: 'orders',
        name: 'Orders Domain',
        version: '0.0.1',
        markdown: '',
      });

      await plugin(config, {
        region: 'us-east-1',
        registryName: 'discovered-schemas',
        services: [{ id: 'Orders Service', version: '1.0.0' }],
        domain: { id: 'orders', name: 'Orders Domain', version: '1.0.0' },
      });

      const versionedDomain = await getDomain('orders', '0.0.1');
      const newDomain = await getDomain('orders', '1.0.0');

      expect(versionedDomain.version).toEqual('0.0.1');
      expect(newDomain.version).toEqual('1.0.0');
      expect(newDomain.services).toEqual([{ id: 'Orders Service', version: '1.0.0' }]);
    });

    it('if multiple services processed for a domain, they are all added to the domain', async () => {
      const { getDomain } = utils(catalogDir);

      await plugin(config, {
        region: 'us-east-1',
        registryName: 'discovered-schemas',
        services: [
          { id: 'Orders Service', version: '1.0.0' },
          { id: 'Account Service', version: '1.0.0' },
        ],
        domain: { id: 'orders', name: 'Orders Domain', version: '1.0.0' },
      });

      const domain = await getDomain('orders', 'latest');

      expect(domain.services).toHaveLength(2);
      expect(domain.services).toEqual([
        { id: 'Orders Service', version: '1.0.0' },
        { id: 'Account Service', version: '1.0.0' },
      ]);
    });

    it('if a domain is not defined in the eventbridge plugin configuration, the service is not added to any domains', async () => {
      const { getDomain } = utils(catalogDir);

      await plugin(config, {
        region: 'us-east-1',
        registryName: 'discovered-schemas',
        services: [{ id: 'Orders Service', version: '1.0.0' }],
      });

      expect(await getDomain('orders', '1.0.0')).toBeUndefined();
    });
  });

  describe('service', () => {
    it('creates a service in EventCatalog and maps EventBridge events into that service', async () => {
      const { getService } = utils(catalogDir);

      await plugin(config, {
        region: 'us-east-1',
        registryName: 'discovered-schemas',
        services: [{ id: 'Orders Service', version: '1.0.0' }],
      });

      const service = await getService('Orders Service');

      expect(service.id).toEqual('Orders Service');
      expect(service.name).toEqual('Orders Service');
    });

    it('when the service is already defined in EventCatalog and the versions match, only metadata is updated and markdown is persisted', async () => {
      const { writeService, getService } = utils(catalogDir);

      await writeService({
        id: 'Orders Service',
        version: '1.0.0',
        name: 'Random Name',
        markdown: 'old markdown',
      });

      await plugin(config, {
        region: 'us-east-1',
        registryName: 'discovered-schemas',
        services: [{ id: 'Orders Service', version: '1.0.0' }],
      });

      const service = await getService('Orders Service');

      expect(service).toEqual(
        expect.objectContaining({
          id: 'Orders Service',
          name: 'Orders Service',
          version: '1.0.0',
          markdown: 'old markdown',
        })
      );
    });

    it('when the service is already defined in EventCatalog and the versions do not match, a new service is created and the old one is versioned', async () => {
      const { writeService, getService } = utils(catalogDir);

      await writeService({
        id: 'Orders Service',
        version: '0.0.1',
        name: 'Random Name',
        markdown: 'old markdown',
      });

      await plugin(config, {
        region: 'us-east-1',
        registryName: 'discovered-schemas',
        services: [{ id: 'Orders Service', version: '1.0.0' }],
      });

      const versionedService = await getService('Orders Service', '0.0.1');
      const newService = await getService('Orders Service', '1.0.0');
      expect(versionedService).toBeDefined();
      expect(newService).toBeDefined();
    });

    describe('produces events (sends)', () => {
      it('maps EventBridge events matching the given `detailType` into the given service', async () => {
        const { getEvent, getService } = utils(catalogDir);

        await plugin(config, {
          region: 'us-east-1',
          registryName: 'discovered-schemas',
          services: [{ id: 'Orders Service', version: '1.0.0', sends: [{ detailType: 'UserSignedUp' }] }],
        });

        const event = await getEvent('UserSignedUp');
        const service = await getService('Orders Service');

        expect(service.sends?.length).toEqual(1);
        expect(service.sends?.[0]).toEqual({ id: 'UserSignedUp', version: '1' });

        expect(event).toEqual({
          id: 'UserSignedUp',
          name: 'UserSignedUp',
          version: '1',
          markdown: expect.any(String),
          schemaPath: 'myapp.users@UserSignedUp-jsondraft.json',
          badges: expect.anything(),
        });
      });

      it('maps EventBridge events matching multiple `detailType` values into the given service', async () => {
        const { getEvent, getService } = utils(catalogDir);

        await plugin(config, {
          region: 'us-east-1',
          registryName: 'discovered-schemas',
          services: [{ id: 'Orders Service', version: '1.0.0', sends: [{ detailType: ['UserSignedUp', 'OrderPlaced'] }] }],
        });

        const userSignedUp = await getEvent('UserSignedUp');
        const orderPlaced = await getEvent('OrderPlaced');
        const service = await getService('Orders Service');

        expect(service.sends?.length).toEqual(2);
        expect(service.sends?.[0]).toEqual({ id: 'UserSignedUp', version: '1' });
        expect(service.sends?.[1]).toEqual({ id: 'OrderPlaced', version: '10' });

        expect(orderPlaced).toBeDefined();
        expect(userSignedUp).toBeDefined();
      });

      it('maps EventBridge events matching `prefix` values into the given service', async () => {
        const { getEvent, getService } = utils(catalogDir);

        await plugin(config, {
          region: 'us-east-1',
          registryName: 'discovered-schemas',
          services: [{ id: 'Orders Service', version: '1.0.0', sends: [{ prefix: 'myapp.users' }] }],
        });

        const userSignedUp = await getEvent('UserSignedUp');
        const userLoggedIn = await getEvent('UserLoggedIn');
        const orderPlaced = await getEvent('OrderPlaced');
        const service = await getService('Orders Service');

        expect(service.sends?.length).toEqual(2);
        expect(service.sends?.[0]).toEqual({ id: 'UserSignedUp', version: '1' });
        expect(service.sends?.[1]).toEqual({ id: 'UserLoggedIn', version: '3' });

        expect(userLoggedIn).toBeDefined();
        expect(userSignedUp).toBeDefined();

        expect(orderPlaced).not.toBeDefined();
      });

      it('maps EventBridge events matching multiple `prefix` values into the given service', async () => {
        const { getEvent, getService } = utils(catalogDir);

        await plugin(config, {
          region: 'us-east-1',
          registryName: 'discovered-schemas',
          services: [{ id: 'Orders Service', version: '1.0.0', sends: [{ prefix: ['myapp.users', 'myapp.orders'] }] }],
        });

        const userSignedUp = await getEvent('UserSignedUp');
        const userLoggedIn = await getEvent('UserLoggedIn');
        const orderPlaced = await getEvent('OrderPlaced');

        const service = await getService('Orders Service');

        expect(service.sends?.length).toEqual(3);
        expect(service.sends?.[0]).toEqual({ id: 'UserSignedUp', version: '1' });
        expect(service.sends?.[1]).toEqual({ id: 'UserLoggedIn', version: '3' });
        expect(service.sends?.[2]).toEqual({ id: 'OrderPlaced', version: '10' });

        expect(userLoggedIn).toBeDefined();
        expect(userSignedUp).toBeDefined();
        expect(orderPlaced).toBeDefined();
      });

      it('maps EventBridge events matching `suffix` values into the given service', async () => {
        const { getEvent, getService } = utils(catalogDir);

        await plugin(config, {
          region: 'us-east-1',
          registryName: 'discovered-schemas',
          services: [{ id: 'Orders Service', version: '1.0.0', sends: [{ suffix: 'SignedUp' }] }],
        });

        const userSignedUp = await getEvent('UserSignedUp');
        const userLoggedIn = await getEvent('UserLoggedIn');
        const orderPlaced = await getEvent('OrderPlaced');
        const service = await getService('Orders Service');

        expect(service.sends?.length).toEqual(1);
        expect(service.sends?.[0]).toEqual({ id: 'UserSignedUp', version: '1' });

        expect(userSignedUp).toBeDefined();

        expect(userLoggedIn).not.toBeDefined();
        expect(orderPlaced).not.toBeDefined();
      });

      it('maps EventBridge events matching multiple `suffix` values into the given service', async () => {
        const { getEvent, getService } = utils(catalogDir);

        await plugin(config, {
          region: 'us-east-1',
          registryName: 'discovered-schemas',
          services: [{ id: 'Orders Service', version: '1.0.0', sends: [{ suffix: ['SignedUp', 'Placed'] }] }],
        });

        const userSignedUp = await getEvent('UserSignedUp');
        const orderPlaced = await getEvent('OrderPlaced');
        const userLoggedIn = await getEvent('UserLoggedIn');
        const service = await getService('Orders Service');

        expect(service.sends?.length).toEqual(2);
        expect(service.sends?.[0]).toEqual({ id: 'UserSignedUp', version: '1' });
        expect(service.sends?.[1]).toEqual({ id: 'OrderPlaced', version: '10' });

        expect(userSignedUp).toBeDefined();
        expect(orderPlaced).toBeDefined();

        expect(userLoggedIn).not.toBeDefined();
      });

      it('maps EventBridge events matching the given source into the given service', async () => {
        const { getEvent, getService } = utils(catalogDir);

        await plugin(config, {
          region: 'us-east-1',
          registryName: 'discovered-schemas',
          services: [{ id: 'Orders Service', version: '1.0.0', sends: [{ source: 'myapp.users' }] }],
        });

        const userSignedUp = await getEvent('UserSignedUp');
        const userLoggedIn = await getEvent('UserLoggedIn');

        const service = await getService('Orders Service');

        expect(service.sends?.length).toEqual(2);
        expect(service.sends?.[0]).toEqual({ id: 'UserSignedUp', version: '1' });
        expect(service.sends?.[1]).toEqual({ id: 'UserLoggedIn', version: '3' });

        expect(userSignedUp).toBeDefined();
        expect(userLoggedIn).toBeDefined();
      });

      it('maps EventBridge events matching multiple `source` values into the given service', async () => {
        const { getEvent, getService } = utils(catalogDir);

        await plugin(config, {
          region: 'us-east-1',
          registryName: 'discovered-schemas',
          services: [{ id: 'Orders Service', version: '1.0.0', sends: [{ source: ['myapp.users', 'myapp.orders'] }] }],
        });

        const userSignedUp = await getEvent('UserSignedUp');
        const orderPlaced = await getEvent('OrderPlaced');
        const userLoggedIn = await getEvent('UserLoggedIn');
        const service = await getService('Orders Service');

        expect(service.sends?.length).toEqual(3);
        expect(service.sends?.[0]).toEqual({ id: 'UserSignedUp', version: '1' });
        expect(service.sends?.[1]).toEqual({ id: 'UserLoggedIn', version: '3' });
        expect(service.sends?.[2]).toEqual({ id: 'OrderPlaced', version: '10' });

        expect(userLoggedIn).toBeDefined();
        expect(userSignedUp).toBeDefined();
        expect(orderPlaced).toBeDefined();
      });

      it('maps EventBridge events matching multiple filters into the given service', async () => {
        const { getEvent, getService } = utils(catalogDir);

        await plugin(config, {
          region: 'us-east-1',
          registryName: 'discovered-schemas',
          services: [
            { id: 'Orders Service', version: '1.0.0', sends: [{ source: ['myapp.users'], detailType: ['OrderPlaced'] }] },
          ],
        });

        const userSignedUp = await getEvent('UserSignedUp');
        const orderPlaced = await getEvent('OrderPlaced');
        const userLoggedIn = await getEvent('UserLoggedIn');
        const service = await getService('Orders Service');

        expect(service.sends?.length).toEqual(3);

        expect(userSignedUp).toBeDefined();
        expect(orderPlaced).toBeDefined();
        expect(userLoggedIn).toBeDefined();
      });
    });

    describe('subscribes to events (receives)', () => {
      it('maps EventBridge events matching the given `detailType` into the given service', async () => {
        const { getEvent, getService } = utils(catalogDir);

        await plugin(config, {
          region: 'us-east-1',
          registryName: 'discovered-schemas',
          credentials: {
            accessKeyId: 'X',
            secretAccessKey: 'X',
            accountId: 'X',
          },
          services: [{ id: 'Orders Service', version: '1.0.0', receives: [{ detailType: 'UserSignedUp' }] }],
        });

        const event = await getEvent('UserSignedUp');
        const service = await getService('Orders Service');

        expect(service.receives?.length).toEqual(1);
        expect(service.receives?.[0]).toEqual({ id: 'UserSignedUp', version: '1' });

        expect(event).toEqual({
          id: 'UserSignedUp',
          name: 'UserSignedUp',
          version: '1',
          markdown: expect.any(String),
          schemaPath: 'myapp.users@UserSignedUp-jsondraft.json',
          badges: expect.anything(),
        });
      });

      it('maps EventBridge events matching multiple `detailType` values into the given service', async () => {
        const { getEvent, getService } = utils(catalogDir);

        await plugin(config, {
          region: 'us-east-1',
          registryName: 'discovered-schemas',
          services: [{ id: 'Orders Service', version: '1.0.0', receives: [{ detailType: ['UserSignedUp', 'OrderPlaced'] }] }],
        });

        const userSignedUp = await getEvent('UserSignedUp');
        const orderPlaced = await getEvent('OrderPlaced');
        const service = await getService('Orders Service');

        expect(service.receives?.length).toEqual(2);
        expect(service.receives?.[0]).toEqual({ id: 'UserSignedUp', version: '1' });
        expect(service.receives?.[1]).toEqual({ id: 'OrderPlaced', version: '10' });

        expect(userSignedUp).toBeDefined();
        expect(orderPlaced).toBeDefined();
      });

      it('maps EventBridge events matching `prefix` values into the given service', async () => {
        const { getEvent, getService } = utils(catalogDir);

        await plugin(config, {
          region: 'us-east-1',
          registryName: 'discovered-schemas',
          services: [{ id: 'Orders Service', version: '1.0.0', receives: [{ prefix: 'myapp.users' }] }],
        });

        const userSignedUp = await getEvent('UserSignedUp');
        const userLoggedIn = await getEvent('UserLoggedIn');
        const orderPlaced = await getEvent('OrderPlaced');
        const service = await getService('Orders Service');

        expect(service.receives?.length).toEqual(2);
        expect(service.receives?.[0]).toEqual({ id: 'UserSignedUp', version: '1' });
        expect(service.receives?.[1]).toEqual({ id: 'UserLoggedIn', version: '3' });

        expect(userLoggedIn).toBeDefined();
        expect(userLoggedIn).toBeDefined();
        expect(userSignedUp).toBeDefined();

        expect(orderPlaced).not.toBeDefined();
      });

      it('maps EventBridge events matching multiple `prefix` values into the given service', async () => {
        const { getEvent, getService } = utils(catalogDir);

        await plugin(config, {
          region: 'us-east-1',
          registryName: 'discovered-schemas',
          services: [{ id: 'Orders Service', version: '1.0.0', receives: [{ prefix: ['myapp.users', 'myapp.orders'] }] }],
        });

        const userSignedUp = await getEvent('UserSignedUp');
        const userLoggedIn = await getEvent('UserLoggedIn');
        const orderPlaced = await getEvent('OrderPlaced');
        const service = await getService('Orders Service');

        expect(service.receives?.length).toEqual(3);
        expect(service.receives?.[0]).toEqual({ id: 'UserSignedUp', version: '1' });
        expect(service.receives?.[1]).toEqual({ id: 'UserLoggedIn', version: '3' });
        expect(service.receives?.[2]).toEqual({ id: 'OrderPlaced', version: '10' });

        expect(userLoggedIn).toBeDefined();
        expect(userSignedUp).toBeDefined();
        expect(orderPlaced).toBeDefined();
      });

      it('maps EventBridge events matching `suffix` values into the given service', async () => {
        const { getEvent, getService } = utils(catalogDir);

        await plugin(config, {
          region: 'us-east-1',
          registryName: 'discovered-schemas',
          services: [{ id: 'Orders Service', version: '1.0.0', receives: [{ suffix: 'SignedUp' }] }],
        });

        const userSignedUp = await getEvent('UserSignedUp');
        const userLoggedIn = await getEvent('UserLoggedIn');
        const orderPlaced = await getEvent('OrderPlaced');
        const service = await getService('Orders Service');

        expect(service.receives?.length).toEqual(1);
        expect(service.receives?.[0]).toEqual({ id: 'UserSignedUp', version: '1' });

        expect(userSignedUp).toBeDefined();
        expect(userLoggedIn).not.toBeDefined();
        expect(orderPlaced).not.toBeDefined();
      });

      it('maps EventBridge events matching multiple `suffix` values into the given service', async () => {
        const { getEvent, getService } = utils(catalogDir);

        await plugin(config, {
          region: 'us-east-1',
          registryName: 'discovered-schemas',
          services: [{ id: 'Orders Service', version: '1.0.0', receives: [{ suffix: ['SignedUp', 'Placed'] }] }],
        });

        const userSignedUp = await getEvent('UserSignedUp');
        const orderPlaced = await getEvent('OrderPlaced');
        const userLoggedIn = await getEvent('UserLoggedIn');
        const service = await getService('Orders Service');

        expect(service.receives?.length).toEqual(2);
        expect(service.receives?.[0]).toEqual({ id: 'UserSignedUp', version: '1' });
        expect(service.receives?.[1]).toEqual({ id: 'OrderPlaced', version: '10' });

        expect(userSignedUp).toBeDefined();
        expect(orderPlaced).toBeDefined();

        expect(userLoggedIn).not.toBeDefined();
      });

      it('maps EventBridge events matching the given source into the given service', async () => {
        const { getEvent, getService } = utils(catalogDir);

        await plugin(config, {
          region: 'us-east-1',
          registryName: 'discovered-schemas',
          services: [{ id: 'Orders Service', version: '1.0.0', receives: [{ source: 'myapp.users' }] }],
        });

        const userSignedUp = await getEvent('UserSignedUp');
        const userLoggedIn = await getEvent('UserLoggedIn');
        const service = await getService('Orders Service');

        expect(service.receives?.length).toEqual(2);
        expect(service.receives?.[0]).toEqual({ id: 'UserSignedUp', version: '1' });
        expect(service.receives?.[1]).toEqual({ id: 'UserLoggedIn', version: '3' });

        expect(userLoggedIn).toBeDefined();
        expect(userSignedUp).toBeDefined();
      });

      it('maps EventBridge events matching multiple `source` values into the given service', async () => {
        const { getEvent, getService } = utils(catalogDir);

        await plugin(config, {
          region: 'us-east-1',
          registryName: 'discovered-schemas',
          services: [{ id: 'Orders Service', version: '1.0.0', receives: [{ source: ['myapp.users', 'myapp.orders'] }] }],
        });

        const userSignedUp = await getEvent('UserSignedUp');
        const orderPlaced = await getEvent('OrderPlaced');
        const userLoggedIn = await getEvent('UserLoggedIn');
        const service = await getService('Orders Service');

        expect(service.receives?.length).toEqual(3);
        expect(service.receives?.[0]).toEqual({ id: 'UserSignedUp', version: '1' });
        expect(service.receives?.[1]).toEqual({ id: 'UserLoggedIn', version: '3' });

        expect(userLoggedIn).toBeDefined();
        expect(userSignedUp).toBeDefined();
        expect(orderPlaced).toBeDefined();
      });
    });

    describe('subscribes and receives events', () => {
      it('maps EventBridge events matching multiple filters into the given service', async () => {
        const { getEvent, getService } = utils(catalogDir);

        await plugin(config, {
          region: 'us-east-1',
          registryName: 'discovered-schemas',
          services: [
            {
              id: 'Orders Service',
              version: '1.0.0',
              receives: [{ source: ['myapp.users'] }],
              sends: [{ source: ['myapp.orders'] }],
            },
          ],
        });

        const userSignedUp = await getEvent('UserSignedUp');
        const orderPlaced = await getEvent('OrderPlaced');
        const userLoggedIn = await getEvent('UserLoggedIn');
        const service = await getService('Orders Service');

        expect(service.receives?.length).toEqual(2);
        expect(service.sends?.length).toEqual(1);

        expect(userSignedUp).toBeDefined();
        expect(orderPlaced).toBeDefined();
        expect(userLoggedIn).toBeDefined();
      });
    });

    describe('schemas', () => {
      it('the EventBridge JSON schema is stored in EventCatalog along side the event', async () => {
        const { getEvent, getService } = utils(catalogDir);

        await plugin(config, {
          region: 'us-east-1',
          registryName: 'discovered-schemas',
          services: [
            {
              id: 'Orders Service',
              version: '1.0.0',
              receives: [{ source: ['myapp.users'] }],
              sends: [{ source: ['myapp.orders'] }],
            },
          ],
        });

        const userSignedUp = await getEvent('UserSignedUp');

        expect(userSignedUp.schemaPath).toEqual('myapp.users@UserSignedUp-jsondraft.json');
        const jsonDraftSchema = await fs.readFile(
          join(catalogDir, 'events', 'UserSignedUp', 'myapp.users@UserSignedUp-jsondraft.json')
        );
        const openAPISchema = await fs.readFile(
          join(catalogDir, 'events', 'UserSignedUp', 'myapp.users@UserSignedUp-openapi.json')
        );

        expect(jsonDraftSchema).toBeDefined();
        expect(openAPISchema).toBeDefined();
      });
    });
  });

  describe('events', () => {
    it('when a message is written to EventCatalog the version number is taken from the schema VersionCount', async () => {
      const { writeEvent, getEvent } = utils(catalogDir);

      await plugin(config, {
        region: 'us-east-1',
        registryName: 'discovered-schemas',
        services: [
          {
            id: 'Orders Service',
            version: '1.0.0',
            sends: [{ source: ['myapp.orders'] }],
          },
        ],
      });

      const versionedEvent = await getEvent('OrderPlaced', '10');

      expect(versionedEvent).toBeDefined();
    });

    it('when the message already exists in EventCatalog but the versions do not match, the existing message is versioned', async () => {
      const { writeEvent, getEvent } = utils(catalogDir);

      await writeEvent({
        id: 'UserSignedUp',
        version: '0.0.1',
        name: 'UserSignedUp',
        markdown: '',
      });

      await plugin(config, {
        region: 'us-east-1',
        registryName: 'discovered-schemas',
        services: [
          {
            id: 'Orders Service',
            version: '1.0.0',
            receives: [{ source: ['myapp.users'] }],
            sends: [{ source: ['myapp.orders'] }],
          },
        ],
      });

      const versionedEvent = await getEvent('UserSignedUp', '0.0.1');
      const newEvent = await getEvent('UserSignedUp', 'latest');

      expect(versionedEvent).toBeDefined();
      expect(newEvent).toBeDefined();
    });

    it('when a the message already exists in EventCatalog the markdown is persisted and not overwritten', async () => {
      const { writeEvent, getEvent } = utils(catalogDir);

      await writeEvent({
        id: 'UserSignedUp',
        version: '0.0.1',
        name: 'UserSignedUp',
        markdown: 'Please do not overwrite me',
      });

      await plugin(config, {
        region: 'us-east-1',
        registryName: 'discovered-schemas',
        services: [
          {
            id: 'Orders Service',
            version: '1.0.0',
            receives: [{ source: ['myapp.users'] }],
            sends: [{ source: ['myapp.orders'] }],
          },
        ],
      });

      const newEvent = await getEvent('UserSignedUp', 'latest');

      expect(newEvent.markdown).toEqual('Please do not overwrite me');
    });

    it('the event bus name is added as a badge onto the event when `eventBusName` is set on the generator', async () => {
      const { writeEvent, getEvent } = utils(catalogDir);

      await plugin(config, {
        region: 'us-east-1',
        registryName: 'discovered-schemas',
        eventBusName: 'my-event-bus',
        services: [
          {
            id: 'Orders Service',
            version: '1.0.0',
            receives: [{ source: ['myapp.users'] }],
            sends: [{ source: ['myapp.orders'] }],
          },
        ],
      });

      const event = await getEvent('UserSignedUp', 'latest');

      expect(event.badges).toEqual([
        {
          content: 'Bus: my-event-bus',
          backgroundColor: 'pink',
          textColor: 'pink',
        },
        {
          content: 'Source: myapp.users',
          backgroundColor: 'pink',
          textColor: 'pink',
        },
        {
          content: 'DetailType: UserSignedUp',
          backgroundColor: 'pink',
          textColor: 'pink',
        },
        {
          content: 'Schema name: myapp.users@UserSignedUp',
          backgroundColor: 'pink',
          textColor: 'pink',
        },
      ]);
    });

    it('the source, detailtype and schema name are added as badges for all events', async () => {
      const { writeEvent, getEvent } = utils(catalogDir);

      await plugin(config, {
        region: 'us-east-1',
        registryName: 'discovered-schemas',
        services: [
          {
            id: 'Orders Service',
            version: '1.0.0',
            receives: [{ source: ['myapp.users'] }],
            sends: [{ source: ['myapp.orders'] }],
          },
        ],
      });

      const event = await getEvent('UserSignedUp', 'latest');

      expect(event.badges).toEqual([
        {
          content: 'Source: myapp.users',
          backgroundColor: 'pink',
          textColor: 'pink',
        },
        {
          content: 'DetailType: UserSignedUp',
          backgroundColor: 'pink',
          textColor: 'pink',
        },
        {
          content: 'Schema name: myapp.users@UserSignedUp',
          backgroundColor: 'pink',
          textColor: 'pink',
        },
      ]);
    });

    describe('events without services', () => {
      it('if no services or domains are provided all the messages are added to EventCatalog without a service', async () => {
        const { getEvent } = utils(catalogDir);

        await plugin(config, {
          region: 'us-east-1',
          registryName: 'discovered-schemas',
          eventBusName: 'my-event-bus',
        });

        const userSignedUp = await getEvent('UserSignedUp', 'latest');
        const userLoggedIn = await getEvent('UserLoggedIn');
        const orderPlaced = await getEvent('OrderPlaced');

        expect(userSignedUp).toBeDefined();
        expect(userLoggedIn).toBeDefined();
        expect(orderPlaced).toBeDefined();
      });
    });

    it('when message does not have source or detailype in registry (custom registry), the schema name is used as the event id', async () => {
      const { writeEvent, getEvent } = utils(catalogDir);

      // Override the mock for this specific test
      vi.mocked(SchemasClient).mockImplementation(
        () =>
          ({
            send: vi.fn((command) => {
              if (command instanceof ListSchemasCommand) {
                return Promise.resolve({
                  Schemas: [{ SchemaName: 'SchemaWithoutSourceAndDetailType', VersionCount: 1 }],
                });
              }
              if (command instanceof ExportSchemaCommand) {
                return Promise.resolve({
                  Content: JSON.stringify({
                    type: 'object',
                    properties: {
                      detail: {
                        type: 'object',
                        properties: {
                          key1: { type: 'string' },
                          key2: { type: 'number' },
                        },
                      },
                    },
                  }),
                });
              }
              if (command instanceof DescribeSchemaCommand) {
                return Promise.resolve({
                  Content: JSON.stringify({
                    openapi: '3.0.0',
                    info: { title: 'Test Schema', version: '1.0.0' },
                    paths: {},
                  }),
                  SchemaVersion: '1',
                  LastModified: new Date('2023-01-01'),
                } as DescribeSchemaCommandOutput);
              }
              return Promise.reject(new Error('Command not mocked'));
            }),
          }) as unknown as SchemasClient
      );

      await plugin(config, {
        region: 'us-east-1',
        registryName: 'discovered-schemas',
        services: [
          {
            id: 'Orders Service',
            version: '1.0.0',
            receives: [{ prefix: ['SchemaWithoutSourceAndDetailType'] }],
          },
        ],
      });

      const event = await getEvent('SchemaWithoutSourceAndDetailType');

      expect(event).toBeDefined();
    });
  });
});
