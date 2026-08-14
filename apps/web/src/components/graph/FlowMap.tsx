import { useMemo, useCallback } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Node,
  Edge,
  NodeTypes,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { StateNode, TransitionEdge } from '../../api/types';
import './FlowMap.css';

interface FlowMapProps {
  nodes: StateNode[];
  edges: TransitionEdge[];
  onNodeClick?: (nodeId: string) => void;
  onEdgeClick?: (edgeId: string) => void;
}

interface CustomNodeData {
  label: string;
  url: string;
  tags: string[];
}

function CustomNode({ data }: { data: CustomNodeData }) {
  const hasCritical = data.tags.includes('critical');

  return (
    <div className={`flow-node ${hasCritical ? 'flow-node--critical' : ''}`}>
      <div className="flow-node__label">{data.label}</div>
      {data.tags && data.tags.length > 0 && (
        <div className="flow-node__tags">
          {data.tags.map((tag: string) => (
            <span
              key={tag}
              className={`flow-node__tag ${tag === 'critical' ? 'flow-node__tag--critical' : ''}`}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const nodeTypes: NodeTypes = {
  default: CustomNode,
  custom: CustomNode,
};

function normalizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname === '/' ? 'Home' : urlObj.pathname.split('/').filter(Boolean).pop() || 'Home';
    return path.charAt(0).toUpperCase() + path.slice(1);
  } catch {
    return url;
  }
}

export function FlowMap({ nodes, edges, onNodeClick, onEdgeClick }: FlowMapProps) {
  const flowNodes: Node[] = useMemo(() => {
    if (!nodes || nodes.length === 0) return [];

    // Simple grid layout based on insertion order
    const COLS = 4;
    const NODE_WIDTH = 200;
    const NODE_HEIGHT = 100;
    const HORIZONTAL_SPACING = 100;
    const VERTICAL_SPACING = 80;

    return nodes.map((node, index) => {
      const col = index % COLS;
      const row = Math.floor(index / COLS);

      return {
        id: node.id,
        type: 'custom',
        position: {
          x: col * (NODE_WIDTH + HORIZONTAL_SPACING),
          y: row * (NODE_HEIGHT + VERTICAL_SPACING),
        },
        data: {
          label: node.label || node.title || normalizeUrl(node.url),
          url: node.url,
          tags: node.tags || [],
        },
      };
    });
  }, [nodes]);

  const flowEdges: Edge[] = useMemo(() => {
    if (!edges || edges.length === 0) return [];

    return edges.map((edge) => {
      const isDashed = edge.confidence < 0.6;

      return {
        id: edge.id,
        source: edge.fromStateId,
        target: edge.toStateId,
        label: edge.action.label || edge.action.type,
        animated: !isDashed,
        style: {
          stroke: isDashed ? '#9ca3af' : '#2563eb',
          strokeWidth: 2,
          strokeDasharray: isDashed ? '5,5' : undefined,
        },
        labelStyle: {
          fontSize: 11,
          fill: '#6b7280',
        },
      };
    });
  }, [edges]);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (onNodeClick) {
        onNodeClick(node.id);
      }
    },
    [onNodeClick]
  );

  const handleEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      if (onEdgeClick) {
        onEdgeClick(edge.id);
      }
    },
    [onEdgeClick]
  );

  if (nodes.length === 0) {
    return (
      <div className="flow-map__empty">
        <p>No nodes discovered yet</p>
        <p className="flow-map__empty-hint">Graph will appear as pages are discovered</p>
      </div>
    );
  }

  return (
    <div className="flow-map">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        fitView
        fitViewOptions={{
          padding: 0.2,
        }}
        minZoom={0.1}
        maxZoom={1.5}
        attributionPosition="bottom-left"
      >
        <Background />
        <Controls />
        <MiniMap
          nodeStrokeWidth={3}
          zoomable
          pannable
        />
      </ReactFlow>
    </div>
  );
}
