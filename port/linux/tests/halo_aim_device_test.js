const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
// Keep generated native-test artifacts inside this checkout and clean them up.
const temp = fs.mkdtempSync(path.join(root, '.halo-aim-test-'));
function block(source, marker) {
 const start=source.indexOf(marker); assert(start>=0, `missing production block: ${marker}`);
 let depth=0, end=source.indexOf('{',start);
 do { if(source[end]==='{') depth++; if(source[end]==='}') depth--; end++; } while(depth>0 && end<source.length);
 assert.equal(depth,0); return source.slice(start,end);
}
function run(args) {
 const r=spawnSync(process.env.CC || 'cc', args, {encoding:'utf8'});
 assert.equal(r.status,0,r.stdout+r.stderr);
}
try {
 const player=fs.readFileSync(path.join(root,'source/game/player_control.c'),'utf8');
 fs.writeFileSync(path.join(temp,'player_camera.inc'), block(player,'if (player_magnetism_flag &&'));
 const binary=path.join(temp,'camera-test');
 run(['-std=c99','-Wall','-Wextra','-Werror','-iquote',path.join(root,'port/linux/include'),'-iquote',temp,path.join(__dirname,'halo_aim_device_test.c'),'-lm','-o',binary]);
 const result=spawnSync(binary,[],{encoding:'utf8'}); assert.equal(result.status,0,result.stdout+result.stderr); console.log(result.stdout.trim());
 const xinput=fs.readFileSync(path.join(root,'port/linux/src/xinput_sdl.c'),'utf8');
 const functions=['static void aim_look_states_initialize_locked','static void aim_look_update_gamepad_locked','int halo_linux_camera_assist_enabled','int halo_linux_mouse_look','static void mouse_poll','DWORD WINAPI XInputGetState'];
 fs.writeFileSync(path.join(temp,'xinput_aim.inc'), functions.map(m=>block(xinput,m)).join('\n'));
 const wiring=path.join(temp,'wiring-test');
 run(['-std=c99','-Wall','-Wextra','-Werror','-iquote',path.join(root,'port/linux/include'),'-iquote',temp,path.join(__dirname,'halo_aim_wiring_test.c'),'-pthread','-o',wiring]);
 const wired=spawnSync(wiring,[],{encoding:'utf8'}); assert.equal(wired.status,0,wired.stdout+wired.stderr); console.log(wired.stdout.trim());
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
