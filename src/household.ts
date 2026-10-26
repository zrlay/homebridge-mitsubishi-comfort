// Household preferences (fork-only: zrlay/homebridge-mitsubishi-comfort).
//
// Opt-in tweaks so Siri stops guessing at modes. Kept in their own file, with
// only one-line hooks in accessory.ts, so syncing from upstream stays clean.
// Every option defaults off, which is upstream behavior.

import { KumoConfig } from './settings';

export const AUTO_MODE_SWITCH_NAME = 'Auto Mode';

// A HomeKit mode write this soon after a setpoint write is treated as part of
// the same Siri request (see keepModeOnTempChange).
export const KEEP_MODE_WINDOW_MS = 2000;

export interface HouseholdPrefs {
  // Remove AUTO from the tile's TargetHeaterCoolerState, so neither Siri nor
  // the Home app can pick it. A unit that is in auto shows as heat or cool.
  hideAutoMode: boolean;
  // Per-unit "Auto Mode" switch: the one explicit way into auto from HomeKit
  // ("Hey Siri, turn on the bedroom Auto Mode").
  autoModeSwitch: boolean;
  // Drop a heat/cool/auto change that arrives alongside a temperature change
  // while the unit is already heating or cooling.
  keepModeOnTempChange: boolean;
}

export function householdPrefs(config: KumoConfig | undefined): HouseholdPrefs {
  return {
    hideAutoMode: config?.hideAutoMode === true,
    autoModeSwitch: config?.autoModeSwitch === true,
    keepModeOnTempChange: config?.keepModeOnTempChange === true,
  };
}

/**
 * Heat or cool to show (or power on into) in place of auto. autoHeat/autoCool
 * say which way the unit is running; plain auto falls back to the last
 * heat/cool mode, then to heat where the unit has it.
 */
export function heatCoolInPlaceOfAuto(
  mode: string,
  lastHeatCool: string | undefined,
  hasHeat: boolean,
): 'heat' | 'cool' {
  if (mode === 'autoHeat') {
    return 'heat';
  }
  if (mode === 'autoCool') {
    return 'cool';
  }
  if (lastHeatCool === 'heat' || lastHeatCool === 'cool') {
    return lastHeatCool;
  }
  return hasHeat ? 'heat' : 'cool';
}

/**
 * Whether a mode write should be dropped as Siri's side effect of a temperature
 * change: the option is on, the unit is on in heat or cool, and a setpoint was
 * written within KEEP_MODE_WINDOW_MS.
 */
export function shouldKeepMode(
  prefs: HouseholdPrefs,
  currentMode: string | undefined,
  power: number | undefined,
  requestedMode: string,
  lastSetpointWriteAt: number,
  now: number = Date.now(),
): boolean {
  return prefs.keepModeOnTempChange &&
    power === 1 &&
    (currentMode === 'heat' || currentMode === 'cool') &&
    requestedMode !== currentMode &&
    now - lastSetpointWriteAt <= KEEP_MODE_WINDOW_MS;
}
