import assert from 'node:assert/strict';
import * as C from '../js/core.js';
import { makeDemoSession } from '../js/demo.js';

for (const rate of [1, 10]) {
  const ses = makeDemoSession({ laps: 6, rateHz: rate });
  const tr = C.processSession(ses);
  const res = C.detectLaps(tr, {});
  console.log(`rate ${rate}Hz samples=${ses.samples.length} doppler=${tr.useDoppler} laps=${res.laps.length} best=${C.fmtLap(res.best?.time)}`);
  console.log(' laps:', res.laps.map(l => l.time.toFixed(2)).join(' '));
  assert.ok(res.laps.length >= 6, 'laps detected');
  const ch = C.lapData(tr, res.best);
  const st = C.lapStats(ch);
  console.log(' len', st.length.toFixed(0), 'vmax', (st.vmax*3.6).toFixed(1), 'brake', st.maxBrake.toFixed(2), 'lat', st.maxLat.toFixed(2), 'acc', st.maxAcc.toFixed(2));
  const rs = C.resampleByDistance(ch, 1);
  const bz = C.brakingZones(rs);
  console.log(' brake zones', bz.map(z => `${z.dStart.toFixed(0)}m ${(z.vEntry*3.6).toFixed(0)}→${(z.vMin*3.6).toFixed(0)} ${z.peakG.toFixed(2)}G`).join(' | '));
  const cs = C.corners(rs);
  console.log(' corners', cs.map(c => `${c.d.toFixed(0)}m ${(c.vMin*3.6).toFixed(0)}km/h ${c.dir} ${c.latG.toFixed(2)}`).join(' | '));
  console.log(' sensor', tr.sensor && { ok: tr.sensor.ok, q: tr.sensor.quality.toFixed(2) });
  const other = res.laps.find(l => l !== res.best && l.valid);
  const rs2 = C.resampleByDistance(C.lapData(tr, other), 1, rs.length);
  const dl = C.deltaTime(rs, rs2);
  assert.ok(Math.abs(dl[dl.length-1] - (other.time - res.best.time)) < 0.05);
}
// IO roundtrip
const ses = makeDemoSession({ laps: 2, rateHz: 1, motion: false });
const back = C.parseCSV(C.toCSV(ses));
assert.equal(back.length, ses.samples.length);
assert.ok(Math.abs(back[10].spd - ses.samples[10].spd) < 0.01);
const g = C.parseGPX(C.toGPX(ses));
assert.equal(g.length, ses.samples.length);
const nmea = '$GPRMC,010203.50,A,3611.4000,N,13907.8000,E,20.0,90.0,221126,,,A*00\n';
const nm = C.parseNMEA(nmea);
assert.ok(Math.abs(nm[0].lat - 36.19) < 1e-6 && Math.abs(nm[0].spd - 10.29) < 0.01);
console.log('OK');
