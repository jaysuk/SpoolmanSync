import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { generateHAConfig } from './ha-config-generator';
import type { HAPrinter } from './api/homeassistant';
import { trayCarriesSpoolSerial } from './creality';
import { detectTrayMismatch } from './tray-mismatch';
import { isDuetUniqueId, parseDuetExtruderUniqueId, DUET_PRINTING_STATES } from './duet';
import type { Spool } from './api/spoolman';

function duetPrinter(extruders = 2): HAPrinter {
  return {
    brand: 'duet',
    entity_id: 'sensor.voron_current_state',
    name: 'Voron',
    state: 'idle',
    prefix: 'voron',
    ams_units: [],
    external_spools: Array.from({ length: extruders }, (_, n) => ({
      entity_id: `sensor.voron_extruder_${n}`,
      unique_id: `extruder-${n}-abc123`,
      tray_number: n,
      is_external: true,
    })),
    filament_extruded_entity: 'sensor.voron_filament_extruded',
  };
}

function generate(printer: HAPrinter = duetPrinter()) {
  const config = generateHAConfig([printer], 'http://hook', 'http://hook', 'SECRET');
  return {
    ...config,
    // Parsed YAML is untyped; these are structural assertions over generated config.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    automations: parseYaml(config.automationsYaml) as any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    additions: parseYaml(config.configurationAdditions) as any,
  };
}

describe('duet unique_id decoding', () => {
  it('parses the extruder index out of a duet3d unique_id', () => {
    expect(parseDuetExtruderUniqueId('extruder-0-abc123')).toBe(0);
    expect(parseDuetExtruderUniqueId('extruder-12-abc123')).toBe(12);
  });

  it('rejects unique_ids that are not extruders', () => {
    expect(parseDuetExtruderUniqueId('Current State-abc123')).toBeNull();
    expect(parseDuetExtruderUniqueId('extruder-x-abc123')).toBeNull();
    expect(parseDuetExtruderUniqueId(undefined)).toBeNull();
  });

  it('matches a sensor by its label, not by entity_id', () => {
    expect(isDuetUniqueId('Current State-abc123', 'Current State')).toBe(true);
    expect(isDuetUniqueId('Filament Extruded-abc123', 'Current State')).toBe(false);
    expect(isDuetUniqueId(null, 'Current State')).toBe(false);
  });
});

describe('duet has no per-spool serial', () => {
  it('never treats a tray_uuid from duet3d as a spool serial', () => {
    expect(trayCarriesSpoolSerial('duet3d')).toBe(false);
  });
});

describe('generateHAConfig — Duet', () => {
  it('produces valid YAML with one tray per extruder', () => {
    const { printerCount, trayCount, automations, additions } = generate(duetPrinter(3));
    expect(printerCount).toBe(1);
    expect(trayCount).toBe(3);
    expect(automations.map(a => a.id)).toEqual([
      'spoolmansync_update_spool_voron',
      'spoolmansync_tray_change_voron',
    ]);
    expect(additions).toHaveProperty('utility_meter');
    expect(additions).toHaveProperty('template');
  });

  it('print end fires only when returning to idle from a filament-consuming state', () => {
    const { automations } = generate();
    const update = automations.find(a => a.id === 'spoolmansync_update_spool_voron')!;
    const printEnd = update.triggers.find((t: { id?: string }) => t.id === 'print_end');
    expect(printEnd.to).toBe('idle');
    expect(printEnd.from).toEqual([...DUET_PRINTING_STATES]);
  });

  it('never bills a simulation to a spool', () => {
    const { automations, additions } = generate();
    const update = automations.find(a => a.id === 'spoolmansync_update_spool_voron')!;
    const printEnd = update.triggers.find((t: { id?: string }) => t.id === 'print_end');
    // simulating -> idle must not trigger a print end...
    expect(printEnd.from).not.toContain('simulating');
    // ...and extrusion during a simulation must not reach the meter
    const usage = additions.template[0].sensor.find(
      (s: { unique_id: string }) => s.unique_id === 'spoolmansync-voron-filament-usage',
    );
    expect(usage.availability).toContain("'simulating'");
  });

  it('converts mm to the cm the webhook expects', () => {
    const { additions } = generate();
    const usage = additions.template[0].sensor.find(
      (s: { unique_id: string }) => s.unique_id === 'spoolmansync-voron-filament-usage',
    );
    expect(usage.unit_of_measurement).toBe('cm');
    expect(usage.state).toContain("states('sensor.voron_filament_extruded') | float(0) / 10");
  });

  it('has a sustained-offline trigger so a blip does not zero the meter', () => {
    const { automations } = generate();
    const update = automations.find(a => a.id === 'spoolmansync_update_spool_voron')!;
    const offline = update.triggers.find((t: { id?: string }) => t.id === 'offline');
    expect(offline.for).toBe('00:02:00');
    expect(offline.to).toContain('halted');
  });

  it('waits for the final extrusion poll and re-reads the meter at print end', () => {
    const { automations } = generate();
    const update = automations.find(a => a.id === 'spoolmansync_update_spool_voron')!;
    const printEndBranch = update.actions[0].choose.find(
      (c: { conditions: Array<{ value_template: string }> }) =>
        c.conditions[0].value_template.includes("'print_end'"),
    );
    const kinds = printEndBranch.sequence.map((step: object) => Object.keys(step)[0]);
    expect(kinds.slice(0, 2)).toEqual(['delay', 'variables']);
    // queued, so a tool change during the wait is not dropped
    expect(update.mode).toBe('queued');
  });

  it('active tray is the extruder of the selected tool, via the "active" attribute', () => {
    const { additions } = generate();
    const activeTray = additions.template[0].sensor.find(
      (s: { unique_id: string }) => s.unique_id === 'spoolmansync-voron-active-tray',
    );
    expect(activeTray.state).toContain("state_attr('sensor.voron_extruder_0', 'active')");
    expect(activeTray.state).toContain("state_attr('sensor.voron_extruder_1', 'active')");
  });

  it('flushes with no serial and no colour', () => {
    const { automationsYaml } = generate();
    expect(automationsYaml).toContain('filament_tray_uuid: ""');
    expect(automationsYaml).not.toContain('rfid');
  });

  it('a filament load reports the tray change, but an empty name is ignored', () => {
    const { automations } = generate();
    const change = automations.find(a => a.id === 'spoolmansync_tray_change_voron')!;
    const condition = change.conditions[1].value_template as string;
    // RRF forgets filament names on reboot; empty must never unassign a spool
    expect(condition).toContain("attributes.get('name', '') != ''");
    expect(change.triggers[0].entity_id).toEqual([
      'sensor.voron_extruder_0',
      'sensor.voron_extruder_1',
    ]);
  });

  it('reports missing usage tracking when the extruded-length sensor is absent', () => {
    const printer = { ...duetPrinter(), filament_extruded_entity: undefined };
    const { missingEntities, additions } = generate(printer);
    expect(missingEntities).toHaveLength(1);
    expect(missingEntities[0].breaksUsageTracking).toBe(true);
    const usage = additions.template[0].sensor.find(
      (s: { unique_id: string }) => s.unique_id === 'spoolmansync-voron-filament-usage',
    );
    expect(usage.availability).toContain('false');
  });

  it('sends the webhook secret on both rest_commands', () => {
    const { additions } = generate();
    expect(additions.rest_command.spoolmansync_update_spool.headers['X-SpoolmanSync-Token']).toBe('SECRET');
    expect(additions.rest_command.spoolmansync_tray_change.headers['X-SpoolmanSync-Token']).toBe('SECRET');
  });
});

describe('detectTrayMismatch — Duet', () => {
  const spool = {
    id: 1,
    filament: { name: 'Prusament PETG', material: 'PETG', color_hex: 'ff0000' },
  } as unknown as Spool;

  it('compares material even though RRF reports no serial', () => {
    const mismatch = detectTrayMismatch(
      { entity_id: 'sensor.voron_extruder_0', tray_number: 0, name: 'PLA', material: 'PLA' },
      spool,
      { brand: 'duet' },
    );
    expect(mismatch?.type).toBe('material');
  });

  it('does not warn when nothing is loaded according to the firmware', () => {
    const mismatch = detectTrayMismatch(
      { entity_id: 'sensor.voron_extruder_0', tray_number: 0, name: '', material: '' },
      spool,
      { brand: 'duet' },
    );
    expect(mismatch).toBeNull();
  });
});
