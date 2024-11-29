import { Event, Filter } from '../types';

const createFilterFunction = (filterKey: 'detailType' | 'prefix' | 'suffix' | 'source') => {
  return (filters: Filter[]) => {
    return (events: Event[]) => {
      if (!filters.some((filter) => filter[filterKey])) {
        return []; // if no filters for this key, return empty array
      }
      return events.reduce((acc: Event[], event) => {
        filters.forEach((filter) => {
          const { eventBusName } = filter;
          if (!filter[filterKey]) return;
          const filterValues = Array.isArray(filter[filterKey]) ? filter[filterKey] : [filter[filterKey]];
          const isMatch = filterValues.some((value) => {
            switch (filterKey) {
              case 'detailType':
                return event.detailType.toLowerCase() === value.toLowerCase();
              case 'prefix':
                return event.schemaName.startsWith(value);
              case 'suffix':
                return event.schemaName.endsWith(value);
              case 'source':
                return event.source.toLowerCase() === value.toLowerCase();
            }
          });
          if (isMatch) {
            acc.push({ ...event, eventBusName });
          }
        });
        return acc;
      }, []);
    };
  };
};

const byDetailType = createFilterFunction('detailType');
const byPrefix = createFilterFunction('prefix');
const bySuffix = createFilterFunction('suffix');
const bySource = createFilterFunction('source');

export const filterEvents = (events: Event[], filters: Filter[]) => {
  const filterFunctions = [byDetailType, byPrefix, bySuffix, bySource];
  const filteredResults = filterFunctions.map((filterFn) => filterFn(filters)(events));

  return filteredResults.reduce((acc, curr) => {
    return acc.concat(curr.filter((event) => !acc.includes(event)));
  }, []);
};
