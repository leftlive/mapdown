// Pure helpers for operations on a multi-selection (behaviour spec 4.1, 2.2).
// Commands turn the results into one session step each.

import type { MapNode } from '../core/types.ts';

/**
 * "Toggle expand/collapse" on a selection: every selected node with children
 * (the root excluded) follows the primary node. The primary is collapsed:
 * all of them open; it is open: all of them collapse. When the primary has no
 * children, the first selected node with children decides. Other collapsed
 * nodes keep their state. Null when no selected node can collapse.
 */
export function collapseToggleTarget(
	root: MapNode,
	collapsed: ReadonlySet<string>,
	selected: readonly MapNode[],
	primary: string | null,
): Set<string> | null {
	const parents = selected.filter((n) => n !== root && n.children.length > 0);
	if (parents.length === 0) return null;
	const lead = parents.find((n) => n.id === primary) ?? parents[0];
	if (!lead) return null;
	const open = collapsed.has(lead.id);
	const out = new Set(collapsed);
	for (const n of parents) {
		if (open) out.delete(n.id);
		else out.add(n.id);
	}
	return out;
}
