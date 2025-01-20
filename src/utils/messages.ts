import { Event } from '../types';

const getRegistryURL = (event: Event) => {
  const baseURL = `https://${event.region}.console.aws.amazon.com`;
  return `${baseURL}/events/home?region=${event.region}#/schemas?registry=${event.registryName}`;
};

const getSchemaURL = (event: Event) => {
  const baseURL = `https://${event.region}.console.aws.amazon.com`;
  return `${baseURL}/events/home?region=${event.region}#/registries/${event.registryName}/schemas/${event.schemaName}`;
};

const getSchemaDownloadURL = (event: Event) => {
  if (event.jsonSchema) {
    return `/generated/events/${event.id}/${event.jsonDraftFileName}`;
  }
  return `/generated/events/${event.id}/${event.openApiFileName}`;
};

export const defaultMarkdown = (event: Event) => {
  return `

## Overview

Documentation for the Amazon EventBridge event ${event.id}.

<Tiles >
    <Tile icon="GlobeAltIcon" href="${getRegistryURL(event)}" openWindow={true} title="Open schema registry" description="Open the ${event.registryName} registry in the AWS console" />
    <Tile icon="GlobeAltIcon" href="${getSchemaURL(event)}" openWindow={true} title="View schema in the AWS console" description="Open the schema for ${event.id} directly in the AWS console" />
    <Tile icon="CodeBracketIcon" href="${getSchemaURL(event)}" openWindow={true} title="Download code bindings" description="Download Java, Python, TypeScript and Go code bindings for ${event.id}" />
    <Tile icon="ArrowDownTrayIcon" href="${getSchemaDownloadURL(event)}" title="Download schema" description="Download the schema for this event" />
</Tiles>  

## How is this event used?
<NodeGraph />

## Schemas

${
  event.jsonSchema
    ? `
### JSON Schema
<SchemaViewer file="${event.jsonDraftFileName}" title="Event Schema" maxHeight="500" />
`
    : ''
}

${
  event.openApiSchema
    ? `
### OpenAPI Schema
\`\`\`json title="OpenAPI Schema"
${JSON.stringify(JSON.parse(event.openApiSchema), null, 2)}
\`\`\`  
`
    : ''
}

`;
};

export const getBadgesForMessage = (event: Event, eventBus?: string) => {
  let badges = [];

  if (eventBus) {
    badges.push({ content: `Bus: ${eventBus}`, backgroundColor: 'pink', textColor: 'pink' });
  }

  badges.push({ content: `Source: ${event.source}`, backgroundColor: 'pink', textColor: 'pink' });
  if (event.detailType) {
    badges.push({ content: `DetailType: ${event.detailType}`, backgroundColor: 'pink', textColor: 'pink' });
  }
  badges.push({ content: `Schema name: ${event.schemaName}`, backgroundColor: 'pink', textColor: 'pink' });

  return badges;
};
