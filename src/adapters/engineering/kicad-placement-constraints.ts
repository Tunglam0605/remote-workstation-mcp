/**
 * Read-only, constraint-first placement proposal engine.
 *
 * Deliberately conservative: even an unblocked proposal needs live KiCad
 * courtyard, copper, schematic parity and DRC acceptance before application.
 */
export type PlacementPoint = { x: number; y: number };
export type PlacementRect = { minX: number; minY: number; maxX: number; maxY: number };

export interface PlacementPart {
  reference: string;
  position: PlacementPoint;
  locked: boolean;
  // AABB of real KiCad courtyard geometry, in absolute PCB coordinates.
  courtyard?: PlacementRect;
}

export interface PlacementAlignmentGroup {
  id: string;
  references: string[];
  axis: 'row' | 'column';
  anchorReference?: string;
  pitchMm?: number;
}

export interface PlacementKeepout {
  id: string;
  bounds: PlacementRect;
}

export interface PlacementConnectorAccess {
  reference: string;
  direction: 'left' | 'right' | 'top' | 'bottom';
  depthMm: number;
  widthMm?: number;
  // Connectors at a PCB edge often need a plug/cable envelope outside the board.
  allowOutsideBoard?: boolean;
}

export interface PlacementConstraintOptions {
  alignmentGroups?: PlacementAlignmentGroup[];
  keepouts?: PlacementKeepout[];
  boardBounds?: PlacementRect;
  minCourtyardGapMm?: number;
  connectorAccess?: PlacementConnectorAccess[];
}

export interface PlacementCandidate {
  groupId: string;
  reference: string;
  currentPositionMm: PlacementPoint;
  targetPositionMm: PlacementPoint;
  proposedPositionMm: PlacementPoint;
  displacementMm: number;
  remainingToTargetMm: number;
  status: 'review' | 'blocked';
  blockers: string[];
  reviewNotes: string[];
}

function validateRect(bounds: PlacementRect, label: string): void {
  if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite) ||
      bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) {
    throw new Error('Invalid placement rectangle: ' + label);
  }
}

function translated(bounds: PlacementRect, dx: number, dy: number): PlacementRect {
  return {
    minX: bounds.minX + dx, minY: bounds.minY + dy,
    maxX: bounds.maxX + dx, maxY: bounds.maxY + dy
  };
}

function overlap(a: PlacementRect, b: PlacementRect, gap: number): boolean {
  const epsilon = 1e-6;
  return a.minX < b.maxX + gap - epsilon && a.maxX > b.minX - gap + epsilon &&
    a.minY < b.maxY + gap - epsilon && a.maxY > b.minY - gap + epsilon;
}

/** Conservative rectangular plug/harness access corridor adjacent to the component courtyard. */
export function connectorAccessEnvelope(courtyard: PlacementRect, spec: PlacementConnectorAccess): PlacementRect {
  const centerX = (courtyard.minX + courtyard.maxX) / 2;
  const centerY = (courtyard.minY + courtyard.maxY) / 2;
  const transverse = spec.widthMm ?? (spec.direction === 'left' || spec.direction === 'right'
    ? courtyard.maxY - courtyard.minY : courtyard.maxX - courtyard.minX);
  const half = transverse / 2;
  switch (spec.direction) {
    case 'left': return { minX: courtyard.minX - spec.depthMm, maxX: courtyard.minX, minY: centerY - half, maxY: centerY + half };
    case 'right': return { minX: courtyard.maxX, maxX: courtyard.maxX + spec.depthMm, minY: centerY - half, maxY: centerY + half };
    case 'top': return { minX: centerX - half, maxX: centerX + half, minY: courtyard.minY - spec.depthMm, maxY: courtyard.minY };
    case 'bottom': return { minX: centerX - half, maxX: centerX + half, minY: courtyard.maxY, maxY: courtyard.maxY + spec.depthMm };
  }
}

function inside(a: PlacementRect, bounds: PlacementRect): boolean {
  const epsilon = 1e-6;
  return a.minX >= bounds.minX - epsilon && a.minY >= bounds.minY - epsilon &&
    a.maxX <= bounds.maxX + epsilon && a.maxY <= bounds.maxY + epsilon;
}

function normalizedRef(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9._+-]{0,31}$/.test(value)) {
    throw new Error('Invalid placement reference: ' + value);
  }
  return value.toUpperCase();
}

export function planConstrainedPlacement(
  parts: PlacementPart[],
  opts: PlacementConstraintOptions,
  fixedReferences: ReadonlySet<string>,
  maxStepMm: number,
  gridMm: number
) {
  const groups = opts.alignmentGroups ?? [];
  const keepouts = opts.keepouts ?? [];
  const connectorAccess = opts.connectorAccess ?? [];
  const minGap = opts.minCourtyardGapMm ?? 0;
  if (groups.length > 32 || keepouts.length > 64 || connectorAccess.length > 128) throw new Error('Too many placement constraints.');
  if (!Number.isFinite(minGap) || minGap < 0 || minGap > 20) throw new Error('Invalid minCourtyardGapMm.');
  if (!Number.isFinite(maxStepMm) || maxStepMm <= 0 || !Number.isFinite(gridMm) || gridMm <= 0) {
    throw new Error('Invalid placement step or grid.');
  }
  if (opts.boardBounds) validateRect(opts.boardBounds, 'boardBounds');
  const keepoutIds = new Set<string>();
  for (const item of keepouts) {
    if (!item.id || item.id.length > 64 || keepoutIds.has(item.id)) throw new Error('Duplicate/invalid keepout id.');
    keepoutIds.add(item.id);
    validateRect(item.bounds, 'keepout ' + item.id);
  }
  const byRef = new Map(parts.map(part => [normalizedRef(part.reference), part]));
  if (byRef.size !== parts.length) throw new Error('Duplicate footprint references in placement analysis.');
  const accesses = new Map<string, PlacementConnectorAccess>();
  for (const spec of connectorAccess) {
    const ref = normalizedRef(spec.reference);
    if (!byRef.has(ref) || accesses.has(ref)) throw new Error('Unknown or duplicate connector access reference ' + ref);
    if (!['left', 'right', 'top', 'bottom'].includes(spec.direction)) throw new Error('Invalid connector access direction.');
    if (!Number.isFinite(spec.depthMm) || spec.depthMm <= 0 || spec.depthMm > 100 ||
        (spec.widthMm !== undefined && (!Number.isFinite(spec.widthMm) || spec.widthMm <= 0 || spec.widthMm > 100))) {
      throw new Error('Invalid connector access envelope dimensions.');
    }
    accesses.set(ref, spec);
  }
  const touched = new Set<string>();
  const groupIds = new Set<string>();
  const candidates: PlacementCandidate[] = [];
  const groupReports: Array<{ id: string; axis: 'row' | 'column'; anchorReference: string; memberCount: number; candidateCount: number; blockedCount: number }> = [];

  for (const group of groups) {
    if (!group.id || group.id.length > 64 || groupIds.has(group.id)) throw new Error('Duplicate/invalid alignment group id.');
    groupIds.add(group.id);
    if (group.axis !== 'row' && group.axis !== 'column') throw new Error('Invalid alignment axis: ' + group.id);
    if (group.references.length < 2 || group.references.length > 64) throw new Error('Alignment group must contain 2..64 references.');
    if (group.pitchMm !== undefined && (!Number.isFinite(group.pitchMm) || group.pitchMm <= 0 || group.pitchMm > 100)) {
      throw new Error('Invalid alignment pitch: ' + group.id);
    }
    const refs = group.references.map(normalizedRef);
    if (new Set(refs).size !== refs.length) throw new Error('Duplicate reference inside group ' + group.id);
    const anchorRef = normalizedRef(group.anchorReference ?? group.references[0]!);
    const anchorIndex = refs.indexOf(anchorRef);
    if (anchorIndex < 0) throw new Error('Alignment anchor not in group: ' + group.id);
    const anchor = byRef.get(anchorRef);
    if (!anchor) throw new Error('Unknown alignment anchor ' + anchorRef);
    const startCount = candidates.length;
    let blockedCount = 0;
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]!;
      if (touched.has(ref)) throw new Error('Overlapping placement groups for ' + ref);
      touched.add(ref);
      const part = byRef.get(ref);
      if (!part) throw new Error('Unknown placement reference ' + ref);
      if (i === anchorIndex) continue;
      const target: PlacementPoint = group.axis === 'row'
        ? { x: group.pitchMm === undefined ? part.position.x : anchor.position.x + (i - anchorIndex) * group.pitchMm, y: anchor.position.y }
        : { x: anchor.position.x, y: group.pitchMm === undefined ? part.position.y : anchor.position.y + (i - anchorIndex) * group.pitchMm };
      const desiredX = target.x - part.position.x;
      const desiredY = target.y - part.position.y;
      const distance = Math.hypot(desiredX, desiredY);
      if (distance <= 1e-7) continue;
      // Quantize the *translation*, not the absolute PCB position:
      // existing KiCad origins may be on 0.25 mm while the move grid is 0.5 mm.
      // Always round toward zero so the declared maximum step cannot be exceeded.
      const ratio = Math.min(1, maxStepMm / distance);
      const quantizedDelta = (delta: number) => {
        const stepped = Math.floor(Math.abs(delta * ratio) / gridMm + 1e-9) * gridMm;
        return Math.sign(delta) * stepped;
      };
      const proposed: PlacementPoint = distance <= maxStepMm
        ? { x: target.x, y: target.y }
        : {
          x: Number((part.position.x + quantizedDelta(desiredX)).toFixed(6)),
          y: Number((part.position.y + quantizedDelta(desiredY)).toFixed(6))
        };
      const blockers: string[] = [];
      const reviewNotes = ['Read-only placement proposal; requires copper rip-up/re-route and official KiCad DRC/parity after any move.'];
      if (part.locked || fixedReferences.has(ref)) blockers.push('fixed-or-locked-footprint');
      if (Math.hypot(proposed.x - part.position.x, proposed.y - part.position.y) <= 1e-7) {
        blockers.push('step-too-small-for-placement-grid');
      }
      if (Math.hypot(proposed.x - part.position.x, proposed.y - part.position.y) > maxStepMm + 1e-7) {
        throw new Error('Placement step limit was exceeded.');
      }
      if (!part.courtyard) {
        blockers.push('missing-courtyard-geometry');
      } else {
        const footprintBox = translated(part.courtyard, proposed.x - part.position.x, proposed.y - part.position.y);
        if (opts.boardBounds && !inside(footprintBox, opts.boardBounds)) blockers.push('outside-declared-board-bounds');
        for (const keepout of keepouts) {
          if (overlap(footprintBox, keepout.bounds, minGap)) blockers.push('keepout:' + keepout.id);
        }
        const ownAccess = accesses.get(ref);
        const ownEnvelope = ownAccess ? connectorAccessEnvelope(footprintBox, ownAccess) : undefined;
        if (ownEnvelope) {
          if (opts.boardBounds && !ownAccess!.allowOutsideBoard && !inside(ownEnvelope, opts.boardBounds)) {
            blockers.push('connector-access-outside-board:' + ref);
          }
          for (const keepout of keepouts) {
            if (overlap(ownEnvelope, keepout.bounds, minGap)) blockers.push('connector-access-keepout:' + keepout.id);
          }
        }
        for (const other of parts) {
          if (other.reference.toUpperCase() === ref) continue;
          if (!other.courtyard) {
            // Full legality cannot be proved without the other footprint's courtyard.
            // Separate mechanical approval is always required, even with 0 blockers.
            continue;
          }
          if (overlap(footprintBox, other.courtyard, minGap)) blockers.push('courtyard:' + other.reference);
          if (ownEnvelope && overlap(ownEnvelope, other.courtyard, minGap)) {
            blockers.push('connector-access-blocked:' + ref + ':' + other.reference);
          }
          const otherAccess = accesses.get(other.reference.toUpperCase());
          if (otherAccess && overlap(footprintBox, connectorAccessEnvelope(other.courtyard, otherAccess), minGap)) {
            blockers.push('blocks-existing-connector-access:' + other.reference);
          }
          if (blockers.length >= 16) break;
        }
      }
      if (Math.hypot(proposed.x - target.x, proposed.y - target.y) > gridMm * 0.71) {
        reviewNotes.push('Step is bounded; alignment target not yet reached.');
      }
      if (parts.some(other => other.reference.toUpperCase() !== ref && !other.courtyard)) {
        reviewNotes.push('Other footprint(s) lack verified courtyard geometry.');
      }
      if (blockers.length) blockedCount++;
      candidates.push({
        groupId: group.id,
        reference: part.reference,
        currentPositionMm: part.position,
        targetPositionMm: target,
        proposedPositionMm: proposed,
        displacementMm: Number(Math.hypot(proposed.x - part.position.x, proposed.y - part.position.y).toFixed(4)),
        remainingToTargetMm: Number(Math.hypot(proposed.x - target.x, proposed.y - target.y).toFixed(4)),
        status: blockers.length ? 'blocked' : 'review',
        blockers,
        reviewNotes
      });
    }
    groupReports.push({
      id: group.id, axis: group.axis, anchorReference: anchorRef,
      memberCount: refs.length, candidateCount: candidates.length - startCount, blockedCount
    });
  }

  return {
    mode: 'read-only-constraint-first' as const,
    requiresFreshCopperAndMechanicalReview: true,
    constraints: { alignmentGroups: groups, keepouts, connectorAccess, boardBounds: opts.boardBounds ?? null, minCourtyardGapMm: minGap },
    groups: groupReports,
    candidates,
    counts: {
      proposals: candidates.length,
      blocked: candidates.filter(item => item.status === 'blocked').length,
      reviewOnly: candidates.filter(item => item.status === 'review').length
    }
  };
}
