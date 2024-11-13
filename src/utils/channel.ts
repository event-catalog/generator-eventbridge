import { DescribeEventBusCommandOutput } from '@aws-sdk/client-eventbridge';
import { Event } from '../types';

const getEventBusUrl = (event: Event) => {
  const baseURL = `https://${event.region}.console.aws.amazon.com`;
  return `${baseURL}/events/home?region=${event.region}#/eventbus/${event.eventBusName}`;
};

const createNewRule = (event: Event) => {
  const baseURL = `https://${event.region}.console.aws.amazon.com`;
  return `${baseURL}/events/home?region=${event.region}#/rules/create?${event.eventBusName}`;
};

const createSendEvents = (event: Event) => {
  const baseURL = `https://${event.region}.console.aws.amazon.com`;
  return `${baseURL}/events/home?region=${event.region}#/eventbuses/sendevents?eventBus=${event.eventBusName}`;
};

const getMonitorURL = (event: Event) => {
  const baseURL = `https://${event.region}.console.aws.amazon.com`;
  return `${baseURL}/events/home?region=${event.region}#/eventbus/${event.eventBusName}?tab=MONITORING`;
};

export const generatedMarkdownByEventBus = (event: Event, eventBusResponse: DescribeEventBusCommandOutput) => {
  return `
  
  ## Overview
  
  Documentation for the Amazon EventBridge Event Bus: ${eventBusResponse.Name}.
  
  <Tiles >
      <Tile icon="GlobeAltIcon" href="${getEventBusUrl(event)}" openWindow={true} title="Open event bus" description="Open the ${event.eventBusName} bus in the AWS console" />
      <Tile icon="GlobeAltIcon" href="${createNewRule(event)}" openWindow={true} title="Create new rule" description="Create a new rule for the ${event.eventBusName} bus" />
      <Tile icon="CodeBracketIcon" href="${createSendEvents(event)}" openWindow={true} title="Send test events" description="Send test events to ${event.eventBusName} in the AWS console." />
      <Tile icon="ChartBarSquareIcon" href="${getMonitorURL(event)}" title="Monitoring" description="AWS dashboard that shows metrics for all event buses" />
  </Tiles>  

  `;
};
