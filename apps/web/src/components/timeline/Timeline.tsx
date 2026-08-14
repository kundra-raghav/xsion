import { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { RunEvent } from '../../api/types';
import './Timeline.css';

interface TimelineProps {
  runId: string;
}

type EventFilter = 'all' | 'steps' | 'errors';

export function Timeline({ runId }: TimelineProps) {
  const timeline = useAppStore((state) => state.timelineByRunId[runId] || []);
  const [filter, setFilter] = useState<EventFilter>('all');

  const filteredEvents = timeline.filter((event) => {
    if (filter === 'all') return true;
    if (filter === 'steps') {
      return event.type.startsWith('step:') || event.type === 'graph:add';
    }
    if (filter === 'errors') {
      return event.type === 'step:error' || (event.type === 'log' && event.level === 'error');
    }
    return true;
  });

  const formatEvent = (event: RunEvent): { time: string; message: string; type: string } => {
    const time = 'ts' in event ? new Date(event.ts).toLocaleTimeString() : '-';

    if (event.type === 'step:start') {
      return {
        time,
        message: `Step ${event.stepIndex}: Found ${event.candidatesCount} candidates on ${event.state.url}`,
        type: 'step-start',
      };
    } else if (event.type === 'step:action') {
      const selector = event.action.selectorBundle
        ? `${event.action.selectorBundle.preferred.kind}:${event.action.selectorBundle.preferred.value || event.action.selectorBundle.preferred.name}`
        : event.action.selector || '';
      return {
        time,
        message: `Click: ${event.action.label || 'Unknown'} (${selector})`,
        type: 'step-action',
      };
    } else if (event.type === 'step:result') {
      return {
        time,
        message: event.createdNewState ? '→ New State' : '→ Existing State',
        type: event.createdNewState ? 'step-result-new' : 'step-result-existing',
      };
    } else if (event.type === 'step:error') {
      return {
        time,
        message: `Error: ${event.message}`,
        type: 'step-error',
      };
    } else if (event.type === 'log') {
      return {
        time,
        message: event.message,
        type: `log-${event.level}`,
      };
    } else if (event.type === 'progress') {
      return {
        time: '-',
        message: `Progress: ${event.progressPct}%`,
        type: 'progress',
      };
    } else if (event.type === 'status') {
      return {
        time: '-',
        message: `Status: ${event.status}`,
        type: 'status',
      };
    } else if (event.type === 'done') {
      return {
        time,
        message: 'Discovery completed',
        type: 'done',
      };
    } else if (event.type === 'graph:add') {
      const nodesCount = event.nodes?.length || 0;
      const edgesCount = event.edges?.length || 0;
      return {
        time,
        message: `Graph updated: +${nodesCount} nodes, +${edgesCount} edges`,
        type: 'graph-add',
      };
    } else if (event.type === 'test:step') {
      return {
        time,
        message: `Test step ${event.stepIndex + 1}: ${event.fromLabel || 'Unknown'} → ${event.toLabel || 'Unknown'}`,
        type: 'test-step',
      };
    } else if (event.type === 'test:fail') {
      return {
        time,
        message: `Test failed at step ${event.stepIndex + 1}: ${event.error}`,
        type: 'test-fail',
      };
    } else if (event.type === 'test:done') {
      return {
        time,
        message: `Test completed: ${event.status === 'pass' ? 'PASSED' : 'FAILED'}`,
        type: event.status === 'pass' ? 'test-pass' : 'test-fail',
      };
    }

    return {
      time: '-',
      message: 'Unknown event',
      type: 'unknown',
    };
  };

  return (
    <div className="timeline">
      <div className="timeline__header">
        <h3 className="timeline__title">Timeline</h3>
        <select
          className="timeline__filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value as EventFilter)}
        >
          <option value="all">All</option>
          <option value="steps">Steps</option>
          <option value="errors">Errors</option>
        </select>
      </div>
      <div className="timeline__events">
        {filteredEvents.length === 0 ? (
          <div className="timeline__empty">No events yet</div>
        ) : (
          filteredEvents.map((event, index) => {
            const formatted = formatEvent(event);
            return (
              <div key={index} className={`timeline__event timeline__event--${formatted.type}`}>
                <span className="timeline__event-time">{formatted.time}</span>
                <span className="timeline__event-type">{event.type}</span>
                <span className="timeline__event-message">{formatted.message}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
