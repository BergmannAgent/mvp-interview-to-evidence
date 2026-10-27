import type { MonitoringEvent, MonitoringEventCategory } from '@orgscience/contracts';
import { useI18n, type Translate } from '@orgscience/frontend-i18n';
import { Filter, Radio, Search } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { eventAgentName, eventSummary, formatClock, truncateIdentifier } from '../view-model.js';
import { JsonDetails } from './JsonDetails.js';

interface EventLogProps {
  readonly events: readonly MonitoringEvent[];
}

type CategoryFilter = 'all' | MonitoringEventCategory;

const categoryFilters: readonly CategoryFilter[] = [
  'all',
  'interview',
  'workflow',
  'agent',
  'transcript',
  'voice',
  'error',
  'retry',
  'state_update',
];

export function EventLog({ events }: EventLogProps): ReactNode {
  const { formatNumber, locale, t } = useI18n();
  const [filter, setFilter] = useState<CategoryFilter>('all');
  const [query, setQuery] = useState('');
  const filteredEvents = useMemo(() => {
    const localeTag = locale === 'en' ? 'en-GB' : 'de-DE';
    const needle = query.trim().toLocaleLowerCase(localeTag);
    return [...events]
      .reverse()
      .filter((event) => filter === 'all' || event.category === filter)
      .filter(
        (event) =>
          needle.length === 0 ||
          `${event.type} ${event.runId} ${eventSummary(locale, t, event)} ${eventAgentName(event) ?? ''}`
            .toLocaleLowerCase(localeTag)
            .includes(needle),
      );
  }, [events, filter, locale, query, t]);

  return (
    <section className="panel event-panel" aria-labelledby="event-title">
      <div className="panel-header event-header">
        <div>
          <span className="panel-kicker">
            {t('monitoring.event.history', { count: formatNumber(events.length) })}
          </span>
          <h2 id="event-title">{t('monitoring.event.title')}</h2>
        </div>
        <label className="event-search">
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">{t('monitoring.event.searchAria')}</span>
          <input
            value={query}
            placeholder={t('monitoring.event.searchPlaceholder')}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </label>
      </div>

      <div className="filter-row" aria-label={t('monitoring.event.filterAria')}>
        <Filter size={15} aria-hidden="true" />
        {categoryFilters.map((category) => (
          <button
            type="button"
            key={category}
            className={filter === category ? 'filter-chip is-active' : 'filter-chip'}
            aria-pressed={filter === category}
            onClick={() => {
              setFilter(category);
            }}
          >
            {categoryLabel(t, category)}
          </button>
        ))}
      </div>

      <div className="event-table-wrap">
        {filteredEvents.length === 0 ? (
          <div className="empty-panel">
            <Radio size={24} aria-hidden="true" />
            <p>{t('monitoring.event.empty')}</p>
          </div>
        ) : (
          <table className="event-table">
            <thead>
              <tr>
                <th>{t('monitoring.event.header.timeSequence')}</th>
                <th>{t('monitoring.event.header.category')}</th>
                <th>{t('monitoring.event.header.event')}</th>
                <th>{t('monitoring.event.header.runAgent')}</th>
                <th>{t('monitoring.event.header.details')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredEvents.map((event) => (
                <tr key={event.eventId}>
                  <td>
                    <strong>{formatClock(locale, event.occurredAt)}</strong>
                    <small>#{formatNumber(event.sequenceNumber)}</small>
                  </td>
                  <td>
                    <span className={`category-label category-${event.category}`}>
                      {categoryLabel(t, event.category)}
                    </span>
                  </td>
                  <td>
                    <strong>{event.type}</strong>
                    <small>{eventSummary(locale, t, event)}</small>
                  </td>
                  <td title={event.runId}>
                    <strong>{truncateIdentifier(event.runId)}</strong>
                    <small>{eventAgentName(event) ?? '–'}</small>
                  </td>
                  <td>
                    <JsonDetails label={t('monitoring.event.payload')} value={event.payload} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function categoryLabel(t: Translate, category: CategoryFilter): string {
  return t(`monitoring.event.category.${category}`);
}
