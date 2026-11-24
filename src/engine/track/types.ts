import type { V3 } from '../core/vec3';

/**
 * Behaviour of the segment that *leaves* a node.
 * - track: unpowered running rail
 * - lift: chain lift; `param` = chain speed (m/s)
 * - launch: linear synchronous motors; `param` = target exit speed (m/s)
 * - brake: magnetic trim / block brake; `param` = target speed (m/s)
 * - station: tyre-driven platform; stops and dispatches the train
 * - tunnel: unpowered, rendered with a tunnel shell
 */
export type SectionKind = 'track' | 'lift' | 'launch' | 'brake' | 'station' | 'tunnel';
export const SECTION_KINDS: readonly SectionKind[] = ['track', 'lift', 'launch', 'brake', 'station', 'tunnel'];

export interface TrackNode {
  /** Stable identifier, used for supports and undo diffing. */
  id: string;
  /** Logical world position in metres (Y up). */
  p: V3;
  /** Unit tangent direction of travel at this node. */
  dir: V3;
  /** Roll in radians relative to the upright reference frame. Positive tilts the up vector towards the right rail. Unwrapped (may exceed 2π). */
  bank: number;
  /** Behaviour of the outgoing segment. */
  kind: SectionKind;
  /** Section parameter, meaning depends on `kind`. */
  param?: number;
  /** Tangent magnitude multiplier for the outgoing segment (1 = circular-arc estimate). */
  tension?: number;
}

export type TrackStyle = 'wood' | 'tubular' | 'boxspine' | 'mine';
export type SupportStyle = 'pine' | 'walnut' | 'painted-timber' | 'weathered' | 'powder-steel' | 'galvanised' | 'industrial';

export interface TrackColours {
  rail: string;
  spine: string;
  sleeper: string;
  support: string;
}

export interface TrackDesign {
  nodes: TrackNode[];
  closed: boolean;
  style: TrackStyle;
  supportStyle: SupportStyle;
  colours: TrackColours;
}

export const RAIL_GAUGE = 1.1; // metres between rail centres
export const MIN_RADIUS = 3.2; // tightest permissible curve radius for the builder (m)
