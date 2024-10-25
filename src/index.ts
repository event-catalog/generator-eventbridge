import utils from '@eventcatalog/sdk';
import chalk from 'chalk';
import {
  SchemasClient,
  DescribeSchemaCommand,
  ListSchemasCommand,
  ExportSchemaCommand,
  DescribeSchemaCommandOutput,
  SchemaSummary,
} from '@aws-sdk/client-schemas';
import { EventCatalogConfig, Event, GeneratorProps, EventMap } from './types';
import { filterEvents } from './utils/filters';
import checkLicense from './checkLicense';

import { defaultMarkdown as generateMarkdownForService } from './utils/services';
import { defaultMarkdown as generateMarkdownForDomain } from './utils/domains';
import { defaultMarkdown as generateMarkdownForMessage, getBadgesForMessage } from './utils/messages';
import { parse } from '@aws-sdk/util-arn-parser';

async function tryFetchJSONSchema(
  schemasClient: SchemasClient,
  registryName: string,
  schemaName: string
): Promise<string | null> {
  try {
    const exportSchemaCommand = new ExportSchemaCommand({
      RegistryName: registryName,
      SchemaName: schemaName,
      Type: 'JSONSchemaDraft4',
    });
    const exportResponse = await schemasClient.send(exportSchemaCommand);
    return exportResponse.Content || null;
  } catch (error) {
    // Can't get the schema, just return null
    // Custom schema regs will either be JSON or OpenAPI we try both...
    // console.error(`Error getting JSON Schema for ${schemaName}:`, error);
    return null;
  }
}

async function tryFetchOpenAPISchema(
  schemasClient: SchemasClient,
  registryName: string,
  schemaName: string
): Promise<DescribeSchemaCommandOutput | null> {
  try {
    const describeSchemaCommand = new DescribeSchemaCommand({
      RegistryName: registryName,
      SchemaName: schemaName,
    });
    const schemaDetails = await schemasClient.send(describeSchemaCommand);
    return schemaDetails || null;
  } catch (error) {
    // Can't get the schema, just return null
    // Custom schema regs will either be JSON or OpenAPI we try both...
    // console.error(`Error getting OpenAPI Schema for ${schemaName}:`, error);
    return null;
  }
}

const fetchSchemasForRegistry =
  (schemasClient: SchemasClient) =>
  async (registryName: string, mapEventsBy: EventMap): Promise<Event[]> => {
    // Get all schemas from discovered-schemas
    const schemas = [] as Event[];
    let allSchemas: SchemaSummary[] = [];
    let nextToken: string | undefined;

    do {
      const listSchemasCommand = new ListSchemasCommand({
        RegistryName: registryName,
        NextToken: nextToken,
      });
      const response = await schemasClient.send(listSchemasCommand);
      allSchemas = [...allSchemas, ...(response.Schemas || [])];
      nextToken = response.NextToken;
    } while (nextToken);

    console.log(chalk.green(`Fetching EventBridge schemas...`));

    for (const schema of allSchemas) {
      if (!schema.SchemaName) {
        console.log(`Skipping schema ${schema.SchemaName} as it has no name`);
        continue;
      }

      const jsonSchema = await tryFetchJSONSchema(schemasClient, registryName, schema.SchemaName);
      const openApiSchema = await tryFetchOpenAPISchema(schemasClient, registryName, schema.SchemaName);

      if ((jsonSchema === null && openApiSchema === null) || !schema.SchemaName) {
        console.log(`Skipping schema ${schema.SchemaName} as both JSON and OpenAPI schemas are null`);
        continue;
      }

      const parts = schema.SchemaName?.split('@');
      const source = parts[0];
      const detailType = parts[1];

      // ARN?
      const arn = schema.SchemaArn ? parse(schema.SchemaArn) : undefined;

      // in custom registries detailType is not a value, so we use schema name
      const id = mapEventsBy === 'detail-type' ? detailType || schema.SchemaName : schema.SchemaName;

      schemas.push({
        id,
        schemaName: schema.SchemaName,
        registryName: registryName,
        source,
        // in custom registries detailType is not set
        detailType,
        jsonSchema,
        openApiSchema: openApiSchema?.Content,
        // Use EventBridge version count
        version: schema.VersionCount?.toString() || '1',
        createdDate: openApiSchema?.VersionCreatedDate,
        // EventBridge versions with every change, we can use this as the minor version
        versionCount: schema.VersionCount || 0,
        region: arn?.region,
        accountId: arn?.accountId,
        jsonDraftFileName: `${schema.SchemaName}-jsondraft.json`,
        openApiFileName: `${schema.SchemaName}-openapi.json`,
      });
    }

    return schemas;
  };

export default async (config: EventCatalogConfig, options: GeneratorProps) => {
  // This is set by EventCatalog. This is the directory where the catalog is stored
  const eventCatalogDirectory = process.env.PROJECT_DIR;
  const { services, region, mapEventsBy = 'detail-type' } = options;
  const schemasClient = new SchemasClient({ region, credentials: config.credentials });

  if (!eventCatalogDirectory) {
    throw new Error('Please provide catalog url (env variable PROJECT_DIR)');
  }

  // EventCatalog SDK (https://www.eventcatalog.dev/docs/sdk)
  const {
    writeService,
    writeDomain,
    getDomain,
    versionDomain,
    addServiceToDomain,
    getService,
    versionService,
    getSpecificationFilesForService,
    rmServiceById,
  } = utils(eventCatalogDirectory);

  const events = await fetchSchemasForRegistry(schemasClient)(options.registryName, mapEventsBy);

  // If no domain or services, just write all messages to catalog.
  if (!options.domain && !options.services) {
    await processEvents(events, options);
    return;
  }

  if (!services) {
    throw new Error('Please provide services for your events. Please see the generator example and API docs');
  }

  console.log(chalk.green(`Processing ${services.length} services with EventBridge...`));

  for (const service of services) {
    console.log(chalk.gray(`Processing ${service.id}`));

    let sendsEvents = [] as Event[];
    let receivesEvents = [] as Event[];

    if (service.sends) {
      sendsEvents = filterEvents(events, service.sends);
    }

    if (service.receives) {
      receivesEvents = filterEvents(events, service.receives);
    }

    const eventsToWrite = [...sendsEvents, ...receivesEvents];

    await processEvents(eventsToWrite, options);

    // Manage domain
    if (options.domain) {
      // Try and get the domain
      const { id: domainId, name: domainName, version: domainVersion } = options.domain;
      const domain = await getDomain(options.domain.id, domainVersion || 'latest');
      const currentDomain = await getDomain(options.domain.id, 'latest');

      console.log(chalk.blue(`\nProcessing domain: ${domainName} (v${domainVersion})`));

      // Found a domain, but the versions do not match
      if (currentDomain && currentDomain.version !== domainVersion) {
        await versionDomain(domainId);
        console.log(chalk.cyan(` - Versioned previous domain (v${currentDomain.version})`));
      }

      // Do we need to create a new domain?
      if (!domain || (domain && domain.version !== domainVersion)) {
        await writeDomain({
          id: domainId,
          name: domainName,
          version: domainVersion,
          markdown: generateMarkdownForDomain(),
          // services: [{ id: serviceId, version: version }],
        });
        console.log(chalk.cyan(` - Domain (v${domainVersion}) created`));
      }

      if (currentDomain && currentDomain.version === domainVersion) {
        console.log(chalk.yellow(` - Domain (v${domainVersion}) already exists, skipped creation...`));
      }

      // Add the service to the domain
      await addServiceToDomain(domainId, { id: service.id, version: service.version }, domainVersion);
    }

    // Check if service is already defined... if the versions do not match then create service.
    const latestServiceInCatalog = await getService(service.id, 'latest');
    let serviceMarkdown = generateMarkdownForService();
    let serviceSpecifications = {};
    let serviceSpecificationsFiles = [];
    let sends = sendsEvents.map((event) => ({ id: event.detailType || event.schemaName, version: event.version || 'latest' }));
    let receives = receivesEvents.map((event) => ({
      id: event.detailType || event.schemaName,
      version: event.version || 'latest',
    }));
    let owners = [] as any;

    console.log(chalk.blue(`Processing service: ${service.id} (v${service.version})`));

    if (latestServiceInCatalog) {
      serviceMarkdown = latestServiceInCatalog.markdown;
      owners = latestServiceInCatalog.owners || [];
      // Found a service, and versions do not match, we need to version the one already there
      if (latestServiceInCatalog.version !== service.version) {
        await versionService(service.id);
        console.log(chalk.cyan(` - Versioned previous service (v${latestServiceInCatalog.version})`));
      }

      // Match found, override it
      if (latestServiceInCatalog.version === service.version) {
        // we want to preserve the markdown any any spec files that are already there
        serviceMarkdown = latestServiceInCatalog.markdown;
        serviceSpecifications = latestServiceInCatalog.specifications ?? {}; // Why this not here?
        sends = latestServiceInCatalog.sends ? [...latestServiceInCatalog.sends, ...sends] : sends;
        receives = latestServiceInCatalog.receives ? [...latestServiceInCatalog.receives, ...receives] : receives;
        serviceSpecificationsFiles = await getSpecificationFilesForService(
          latestServiceInCatalog.id,
          latestServiceInCatalog.version
        );
        await rmServiceById(service.id);
      }
    }

    await writeService({
      id: service.id,
      markdown: serviceMarkdown,
      name: service.id,
      version: service.version,
      sends,
      receives,
      specifications: serviceSpecifications,
      owners: owners,
    });
  }

  console.log(chalk.green(`\nFinished generating event catalog with EventBridge schema registry ${options.registryName}`));

  await checkLicense();
};

const processEvents = async (events: Event[], options: GeneratorProps) => {
  // This is set by EventCatalog. This is the directory where the catalog is stored
  const eventCatalogDirectory = process.env.PROJECT_DIR;

  if (!eventCatalogDirectory) {
    throw new Error('Please provide catalog url (env variable PROJECT_DIR)');
  }

  // EventCatalog SDK (https://www.eventcatalog.dev/docs/sdk)
  const { getEvent, writeEvent, addSchemaToEvent, rmEventById, versionEvent } = utils(eventCatalogDirectory);

  for (const event of events) {
    // in custom registries detailType is not a value, so we use schema name
    console.log(chalk.blue(`Processing event: ${event.id} (v${event.version})`));

    const schemaPath = event.jsonSchema ? event.jsonDraftFileName : event.openApiSchema ? event.openApiFileName : '';
    let messageMarkdown = generateMarkdownForMessage(event);
    const catalogedEvent = await getEvent(event.id, event.version);

    if (catalogedEvent) {
      // Persist markdown between versions
      messageMarkdown = catalogedEvent.markdown;

      // if the version matches, we can override the message but keep markdown as it  was
      if (catalogedEvent.version === event.version) {
        await rmEventById(event.id, event.version);
      } else {
        // if the version does not match, we need to version the message
        await versionEvent(event.id);
        console.log(chalk.cyan(` - Versioned previous message: (v${catalogedEvent.version})`));
      }
    }

    await writeEvent({
      id: event.id,
      name: event.id,
      version: event.version?.toString() || '',
      schemaPath,
      markdown: messageMarkdown,
      badges: getBadgesForMessage(event, options.eventBusName),
    });

    console.log(chalk.cyan(` - Event (${event.id} v${event.version}) created`));

    if (event.jsonSchema) {
      await addSchemaToEvent(event.id, { fileName: event.jsonDraftFileName, schema: event.jsonSchema });
      console.log(chalk.cyan(` - Schema added to event (v${event.version})`));
    }

    if (event.openApiSchema) {
      await addSchemaToEvent(event.id, { fileName: event.openApiFileName, schema: event.openApiSchema });
      console.log(chalk.cyan(` - Schema added to event (v${event.version})`));
    }
  }
};
