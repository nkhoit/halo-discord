#include <assert.h>
#include <math.h>
#include <stdio.h>
#include "halo_aim_device.h"
#define HALO_LINUX 1
#define PIN(v, lo, hi) fminf(fmaxf((v), (lo)), (hi))
#define DEGREES_TO_RADIANS(v) ((v) * 0.0174532925f)
#define _real_epsilon 0.00001f
#define real float
static int assist;
static int halo_linux_camera_assist_enabled(short port) { (void)port; return assist; }
static float game_time_get_speed(void) { return 1.f; }
static int game_players_are_double_speed(void) { return 0; }
/* Execute the actual production camera condition and blend, not a WASD flag. */
static float camera(float look, float movement, float velocity)
{
 struct { float magnetism_level; } c = {0.8f}, *control = &c;
 struct { float magnetism_friction, magnetism_adhesion; } k = {0.5f, 0.6f}, *constants = &k;
 struct { struct {float i,j;} throttle; } in = {{movement,0}}, *input = &in;
 struct {float yaw,pitch;} look_delta = {look,look}, target_angular_velocity = {velocity,velocity};
 float clamped_yaw = look, clamped_pitch = look;
 int player_magnetism_flag = 1;
 short gamepad_index = 0;
 #include "player_camera.inc"
 return look_delta.yaw;
}
int main(void)
{
 struct halo_aim_look_state p[4];
 for (int i=0;i<4;i++) halo_aim_look_state_reset(&p[i], i ? _halo_aim_look_device_controller : _halo_aim_look_device_mouse);
 assert(!halo_aim_look_camera_assist_allowed(&p[0]));
 for(int i=1;i<4;i++) assert(halo_aim_look_camera_assist_allowed(&p[i]));
 for(int sign=-1;sign<=1;sign+=2) {
  halo_aim_look_state_reset(&p[0], _halo_aim_look_device_mouse);
  halo_aim_look_note_controller_sample(&p[0], sign*9000,0,0);
  assert(!halo_aim_look_camera_assist_allowed(&p[0]));
  halo_aim_look_note_controller_sample(&p[0], sign*9001,0,1);
  assert(halo_aim_look_camera_assist_allowed(&p[0]));
  halo_aim_look_note_controller_sample(&p[0],0,0,16);
  halo_aim_look_note_controller_sample(&p[0],0,0,100000);
  assert(halo_aim_look_camera_assist_allowed(&p[0]));
 }
 halo_aim_look_note_controller_sample(&p[0],16000,0,2);
 halo_aim_look_note_mouse_motion(&p[0],1);
 for(int i=0;i<100;i++) halo_aim_look_note_controller_sample(&p[0],16000+(i%3)*300,0,i);
 assert(!halo_aim_look_camera_assist_allowed(&p[0]));
 halo_aim_look_note_controller_sample(&p[0],17000,0,200);
 assert(halo_aim_look_camera_assist_allowed(&p[0]));
 halo_aim_look_note_mouse_motion(&p[0],1);
 halo_aim_look_note_controller_sample(&p[0],8500,0,201);
 halo_aim_look_note_controller_sample(&p[0],8999,0,202);
 assert(!halo_aim_look_camera_assist_allowed(&p[0]));
 halo_aim_look_note_controller_sample(&p[0],7000,0,203);
 halo_aim_look_note_controller_sample(&p[0],0,-9001,204);
 assert(halo_aim_look_camera_assist_allowed(&p[0]));
 halo_aim_look_note_mouse_motion(&p[0],1);
 halo_aim_look_note_mouse_motion(&p[0],0);
 assist=halo_aim_look_camera_assist_allowed(&p[0]);
 for(int t=0;t<60;t++) {
  /* A moving target and actual movement must not change zero-look facing. */
  assert(camera(0,1,(t%2 ? -1.f : 1.f)*0.08f)==0);
  assert(camera(0,0,0.08f)==0);
  assert(camera(0.02f,1,0.08f)==0.02f);
 }
 for(int i=1;i<4;i++) assert(halo_aim_look_camera_assist_allowed(&p[i]));
 assist=1;
 assert(fabsf(camera(0,1,0.08f)-0.08f*0.8f*0.6f)<0.00001f);
 assert(fabsf(camera(0.02f,1,0.08f)-(0.08f*0.8f*0.6f+0.02f*(1-0.8f*0.5f)))<0.00001f);
 assert(camera(0,0,0.08f)==0);
 puts("PASS: production camera WASD/zero-look/target motion, controller parity, per-port transitions/deadzone/noise/persistent ownership");
 return 0;
}
