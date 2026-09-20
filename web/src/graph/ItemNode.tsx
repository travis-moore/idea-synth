import { Handle, Position } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import type { ItemDto } from '../../../src/api-types';
import { KIND_LABELS, ORIGIN_LABELS, STATUS_LABELS, truncate } from '../labels';

/** `isNew`: the item arrived while the map was open (e.g. added by a coding agent): it glows briefly. */
export type ItemFlowNode = Node<{ item: ItemDto; isNew: boolean }, 'item'>;

/**
 * Handles on both sides, in both roles: edges keep their semantic direction, so an edge may
 * leave from the top of a lower node (e.g. child --derived from--> parent).
 */
export const HANDLES = {
  topSource: 'top-source',
  topTarget: 'top-target',
  bottomSource: 'bottom-source',
  bottomTarget: 'bottom-target',
} as const;

export function ItemNode({ data, selected }: NodeProps<ItemFlowNode>) {
  const { item } = data;
  const classes = [
    'map-node',
    `origin-${item.origin}`,
    `status-${item.status}`,
    `kind-${item.kind}`,
  ];
  if (selected) classes.push('selected');
  if (data.isNew) classes.push('is-new');
  const productive = item.productiveDescendantIds.length > 0;
  return (
    <div className={classes.join(' ')} title={item.text}>
      <Handle type="target" position={Position.Top} id={HANDLES.topTarget} isConnectable={false} />
      <Handle type="source" position={Position.Top} id={HANDLES.topSource} isConnectable={false} />
      <div className="map-node-head">
        <span className="map-node-kind">{KIND_LABELS[item.kind]}</span>
        <span className="map-node-status">{STATUS_LABELS[item.status]}</span>
      </div>
      <div className="map-node-text">{truncate(item.text, 90)}</div>
      <div className="map-node-foot">
        <span className="map-node-origin">{ORIGIN_LABELS[item.origin]}</span>
        {productive && <span className="map-node-productive">False premise · productive</span>}
      </div>
      <Handle
        type="target"
        position={Position.Bottom}
        id={HANDLES.bottomTarget}
        isConnectable={false}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id={HANDLES.bottomSource}
        isConnectable={false}
      />
    </div>
  );
}
