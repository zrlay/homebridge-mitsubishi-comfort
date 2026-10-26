'use strict';

// Household preferences (fork-only, src/household.ts): hide AUTO from the tile,
// an explicit Auto Mode switch, and temperature changes that keep the mode.
// All default off, so the first block checks upstream behavior is untouched.

const test = require('node:test');
const assert = require('node:assert');
const { KumoThermostatAccessory } = require('../dist/accessory.js');
const { Characteristic, Service, makeLog, makeAccessory } = require('./helpers');

const SERIAL = 'TESTSERIAL001';
const A = Characteristic.Active;
const T = Characteristic.TargetHeaterCoolerState;
const COOL_SP = Characteristic.CoolingThresholdTemperature;

function makeHarness(kumoConfig = {}) {
  const accessory = makeAccessory('Kitchen', SERIAL);
  const sent = [];
  let profileCb = null;
  const platform = {
    Service, Characteristic, log: makeLog(), kumoConfig,
    api: { updatePlatformAccessories() {} },
  };
  const kumoAPI = {
    subscribeToDevice() {},
    onDeviceProfileUpdate(cb) { profileCb = cb; },
    sendCommand(serial, commands) {
      sent.push(commands);
      return Promise.resolve(true);
    },
  };
  const handler = new KumoThermostatAccessory(platform, accessory, kumoAPI, 30);
  const tile = accessory.getService(Service.HeaterCooler);
  return { handler, accessory, tile, sent, applyProfile: (p) => profileCb(SERIAL, p) };
}

const zone = (over = {}) => ({
  id: 'zone-1',
  adapter: {
    deviceSerial: SERIAL, rssi: -50, power: 1, operationMode: 'heat',
    fanSpeed: null, airDirection: null,
    roomTemp: 22, spCool: 25, spHeat: 21, spAuto: null, humidity: null,
    ...over,
  },
});

const profile = (over = {}) => ({
  minimumSetPoints: { cool: 16, heat: 10, auto: 16 },
  maximumSetPoints: { cool: 31, heat: 31, auto: 31 },
  hasModeHeat: true, hasModeVent: true, hasModeDry: true,
  ...over,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Defaults: upstream behavior ------------------------------------------

test('defaults: AUTO stays on the tile and no Auto Mode switch is added', async () => {
  const { handler, tile, accessory, applyProfile } = makeHarness();
  applyProfile(profile());
  assert.deepStrictEqual(tile.getCharacteristic(T).props, { validValues: [T.AUTO, T.HEAT, T.COOL] });
  assert.strictEqual(accessory.getServiceById(Service.Switch, 'auto-mode'), null);
  handler.updateFromZone(zone({ operationMode: 'autoHeat' }));
  assert.strictEqual(await handler.getTargetHeaterCoolerState(), T.AUTO);
});

test('defaults: a mode sent with a temperature change is still applied', async () => {
  const { handler, sent } = makeHarness();
  handler.updateFromZone(zone({ operationMode: 'heat' }));
  await Promise.all([handler.setCoolingThresholdTemperature(23), handler.setTargetHeaterCoolerState(T.AUTO)]);
  assert.ok(sent.some((c) => c.operationMode === 'auto'), JSON.stringify(sent));
});

// ---- hideAutoMode ---------------------------------------------------------

test('hideAutoMode: the tile offers only HEAT and COOL, before and after the profile', () => {
  const { tile, applyProfile } = makeHarness({ hideAutoMode: true });
  assert.deepStrictEqual(tile.getCharacteristic(T).props, { validValues: [T.HEAT, T.COOL] });
  applyProfile(profile());
  assert.deepStrictEqual(tile.getCharacteristic(T).props, { validValues: [T.HEAT, T.COOL] });
  const coolOnly = makeHarness({ hideAutoMode: true });
  coolOnly.applyProfile(profile({ hasModeHeat: false }));
  assert.deepStrictEqual(coolOnly.tile.getCharacteristic(T).props, { validValues: [T.COOL] });
});

test('hideAutoMode: a unit in auto shows as heat or cool, never AUTO', async () => {
  const { handler } = makeHarness({ hideAutoMode: true });
  handler.updateFromZone(zone({ operationMode: 'autoCool' }));
  assert.strictEqual(await handler.getTargetHeaterCoolerState(), T.COOL);
  handler.updateFromZone(zone({ operationMode: 'autoHeat' }));
  assert.strictEqual(await handler.getTargetHeaterCoolerState(), T.HEAT);
  handler.updateFromZone(zone({ operationMode: 'cool' }));
  handler.updateFromZone(zone({ operationMode: 'auto' }));
  assert.strictEqual(await handler.getTargetHeaterCoolerState(), T.COOL, 'plain auto: last heat/cool mode');
});

test('hideAutoMode: power-on after auto resumes the last heat/cool mode', async () => {
  const { handler, sent } = makeHarness({ hideAutoMode: true });
  handler.updateFromZone(zone({ operationMode: 'cool' }));
  handler.updateFromZone(zone({ operationMode: 'auto' }));
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  await handler.setActive(A.ACTIVE);
  assert.deepStrictEqual(sent, [{ operationMode: 'cool' }]);
});

test('hideAutoMode: power-on with nothing remembered goes to heat, not auto', async () => {
  const { handler, sent } = makeHarness({ hideAutoMode: true });
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  await handler.setActive(A.ACTIVE);
  assert.deepStrictEqual(sent, [{ operationMode: 'heat' }]);
});

// ---- autoModeSwitch -------------------------------------------------------

test('autoModeSwitch: added on units with heat, not on cool-only units', () => {
  const withHeat = makeHarness({ autoModeSwitch: true });
  withHeat.applyProfile(profile());
  assert.ok(withHeat.accessory.getServiceById(Service.Switch, 'auto-mode'));

  const coolOnly = makeHarness({ autoModeSwitch: true });
  coolOnly.applyProfile(profile({ hasModeHeat: false }));
  assert.strictEqual(coolOnly.accessory.getServiceById(Service.Switch, 'auto-mode'), null);
});

test('autoModeSwitch: on sends auto, even with AUTO hidden from the tile', async () => {
  const { handler, sent, applyProfile } = makeHarness({ autoModeSwitch: true, hideAutoMode: true });
  applyProfile(profile());
  handler.updateFromZone(zone({ operationMode: 'heat' }));
  await handler.setAutoModeOn(true);
  assert.deepStrictEqual(sent, [{ operationMode: 'auto' }]);
  assert.strictEqual(await handler.getAutoModeOn(), true);
});

test('autoModeSwitch: off turns a unit in auto off, and leaves heat alone', async () => {
  const inAuto = makeHarness({ autoModeSwitch: true });
  inAuto.applyProfile(profile());
  inAuto.handler.updateFromZone(zone({ operationMode: 'autoCool' }));
  await inAuto.handler.setAutoModeOn(false);
  assert.deepStrictEqual(inAuto.sent, [{ operationMode: 'off' }]);

  const inHeat = makeHarness({ autoModeSwitch: true });
  inHeat.applyProfile(profile());
  inHeat.handler.updateFromZone(zone({ operationMode: 'heat' }));
  await inHeat.handler.setAutoModeOn(false);
  assert.deepStrictEqual(inHeat.sent, []);
});

test('autoModeSwitch: follows the unit\'s real mode', () => {
  const { handler, accessory, applyProfile } = makeHarness({ autoModeSwitch: true });
  applyProfile(profile());
  const sw = accessory.getServiceById(Service.Switch, 'auto-mode');
  handler.updateFromZone(zone({ operationMode: 'autoHeat' }));
  assert.strictEqual(sw.getCharacteristic(Characteristic.On).value, true);
  handler.updateFromZone(zone({ operationMode: 'heat' }));
  assert.strictEqual(sw.getCharacteristic(Characteristic.On).value, false);
});

// ---- keepModeOnTempChange -------------------------------------------------

test('keepModeOnTempChange: a mode sent with a temperature change is dropped', async () => {
  const { handler, sent, tile } = makeHarness({ keepModeOnTempChange: true });
  handler.updateFromZone(zone({ operationMode: 'heat' }));
  await Promise.all([handler.setCoolingThresholdTemperature(23), handler.setTargetHeaterCoolerState(T.AUTO)]);
  await sleep(10);
  assert.ok(!sent.some((c) => c.operationMode), `no mode sent: ${JSON.stringify(sent)}`);
  assert.ok(sent.some((c) => c.spCool !== undefined), 'the temperature still goes through');
  assert.strictEqual(tile.getCharacteristic(T).value, T.HEAT, 'tile republished as HEAT');
});

test('keepModeOnTempChange: a mode change on its own still works', async () => {
  const { handler, sent } = makeHarness({ keepModeOnTempChange: true });
  handler.updateFromZone(zone({ operationMode: 'heat' }));
  await handler.setTargetHeaterCoolerState(T.COOL);
  assert.deepStrictEqual(sent, [{ operationMode: 'cool' }]);
});

test('keepModeOnTempChange: an off unit can still be turned on in a mode with a temperature', async () => {
  const { handler, sent } = makeHarness({ keepModeOnTempChange: true });
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  await Promise.all([
    handler.setActive(A.ACTIVE),
    handler.setTargetHeaterCoolerState(T.COOL),
    handler.setCoolingThresholdTemperature(23),
  ]);
  assert.strictEqual(sent[0].operationMode, 'cool');
});

test('keepModeOnTempChange: the tile still reads the threshold the user set', async () => {
  const { handler, tile } = makeHarness({ keepModeOnTempChange: true });
  handler.updateFromZone(zone({ operationMode: 'cool' }));
  await Promise.all([handler.setCoolingThresholdTemperature(23), handler.setTargetHeaterCoolerState(T.HEAT)]);
  assert.ok(Math.abs(tile.getCharacteristic(COOL_SP).value - 23) < 0.5);
});

// ---- hideFanSpeed ---------------------------------------------------------

test('defaults: the fan speed slider is there', () => {
  const { accessory } = makeHarness();
  assert.ok(accessory.getServiceById(Service.Fanv2, 'airflow'));
});

test('hideFanSpeed: no fan speed slider, and a cached one is removed', () => {
  const fresh = makeHarness({ hideFanSpeed: true });
  assert.strictEqual(fresh.accessory.getServiceById(Service.Fanv2, 'airflow'), null);

  // A unit cached with a slider from a run before the option was turned on.
  const { accessory } = makeHarness();
  assert.ok(accessory.getServiceById(Service.Fanv2, 'airflow'));
  const platform = {
    Service, Characteristic, log: makeLog(), kumoConfig: { hideFanSpeed: true },
    api: { updatePlatformAccessories() {} },
  };
  const kumoAPI = { subscribeToDevice() {}, onDeviceProfileUpdate() {}, sendCommand: () => Promise.resolve(true) };
  const handler = new KumoThermostatAccessory(platform, accessory, kumoAPI, 30);
  assert.strictEqual(accessory.getServiceById(Service.Fanv2, 'airflow'), null);
  handler.updateFromZone(zone({ operationMode: 'heat' }));
});

test('hideFanSpeed: power and mode still work without the fan service', async () => {
  const { handler, sent, applyProfile } = makeHarness({ hideFanSpeed: true });
  applyProfile(profile({ hasFanSpeedAuto: true, numberOfFanSpeeds: 3 }));
  handler.updateFromZone(zone({ operationMode: 'heat' }));
  handler.updateFromZone(zone({ operationMode: 'off', power: 0 }));
  await handler.setActive(A.ACTIVE);
  assert.deepStrictEqual(sent, [{ operationMode: 'heat' }]);
});
