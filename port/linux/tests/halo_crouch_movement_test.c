/* Real production keyboard mapping, SDL merge, polling/lifecycle, movement
 * abstraction, crouch block and biped speed blend. Only OS/SDL boundaries and
 * game data are fixtures; no reimplementation of the crouch condition. */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <pthread.h>
#include "halo_aim_device.h"
#include "halo_movement_source.h"
#define REQUIRE(c, message) do { if (!(c)) { fprintf(stderr, "FAIL: %s (line %d)\n", message, __LINE__); exit(1); } } while (0)
#define TRUE 1
#define FALSE 0
#define PORT_COUNT 4
#define MAXIMUM_GAMEPADS 4
#define WINAPI
#define ERROR_SUCCESS 0
#define ERROR_DEVICE_NOT_CONNECTED 1
#define SHORT_MAX 32767
#define SHORT_MIN (-32768)
#define NONE (-1)
#define TICKS_PER_SECOND 30.f
#define MAX(a,b) ((a) > (b) ? (a) : (b))
#define PIN(v,lo,hi) fminf(fmaxf((v),(lo)),(hi))
#define TEST_FLAG(v,b) (((v) & (1u << (b))) != 0)
#define SET_FLAG(v,b,on) ((v) = ((v) & ~(1u << (b))) | ((on) ? (1u << (b)) : 0))
typedef int BOOL, boolean;
typedef float real;
typedef unsigned char BYTE;
typedef unsigned short WORD;
typedef short SHORT, Sint16;
typedef unsigned DWORD, SDL_JoystickID;
typedef uint64_t Uint64;
typedef void *HANDLE, *PXINPUT_POLLING_PARAMETERS;
typedef void VOID;
typedef struct { int unused; } XPP_DEVICE_TYPE, *PXPP_DEVICE_TYPE;
static XPP_DEVICE_TYPE XDEVICE_TYPE_GAMEPAD_TABLE, XDEVICE_TYPE_DEBUG_KEYBOARD_TABLE;
#define XDEVICE_TYPE_GAMEPAD (&XDEVICE_TYPE_GAMEPAD_TABLE)
#define XDEVICE_TYPE_DEBUG_KEYBOARD (&XDEVICE_TYPE_DEBUG_KEYBOARD_TABLE)
enum { XINPUT_GAMEPAD_DPAD_UP=1, XINPUT_GAMEPAD_DPAD_DOWN=2, XINPUT_GAMEPAD_DPAD_LEFT=4,
 XINPUT_GAMEPAD_DPAD_RIGHT=8, XINPUT_GAMEPAD_START=16, XINPUT_GAMEPAD_BACK=32,
 XINPUT_GAMEPAD_LEFT_THUMB=64, XINPUT_GAMEPAD_RIGHT_THUMB=128 };
enum { XINPUT_GAMEPAD_A, XINPUT_GAMEPAD_B, XINPUT_GAMEPAD_X, XINPUT_GAMEPAD_Y,
 XINPUT_GAMEPAD_WHITE, XINPUT_GAMEPAD_BLACK, XINPUT_GAMEPAD_LEFT_TRIGGER, XINPUT_GAMEPAD_RIGHT_TRIGGER };
enum { SDL_SCANCODE_D, SDL_SCANCODE_A, SDL_SCANCODE_W, SDL_SCANCODE_S,
 SDL_SCANCODE_UP, SDL_SCANCODE_DOWN, SDL_SCANCODE_LEFT, SDL_SCANCODE_RIGHT,
 SDL_SCANCODE_ESCAPE, SDL_SCANCODE_F1, SDL_SCANCODE_LCTRL, SDL_SCANCODE_C, SDL_SCANCODE_Z,
 SDL_SCANCODE_SPACE, SDL_SCANCODE_RETURN, SDL_SCANCODE_KP_ENTER, SDL_SCANCODE_F,
 SDL_SCANCODE_BACKSPACE, SDL_SCANCODE_E, SDL_SCANCODE_R, SDL_SCANCODE_TAB,
 SDL_SCANCODE_Q, SDL_SCANCODE_X, SDL_SCANCODE_G };
enum { SDL_BUTTON_LEFT=1, SDL_BUTTON_MIDDLE, SDL_BUTTON_RIGHT, SDL_BUTTON_X1 };
typedef enum { SDL_GAMEPAD_BUTTON_DPAD_UP, SDL_GAMEPAD_BUTTON_DPAD_DOWN, SDL_GAMEPAD_BUTTON_DPAD_LEFT,
 SDL_GAMEPAD_BUTTON_DPAD_RIGHT, SDL_GAMEPAD_BUTTON_START, SDL_GAMEPAD_BUTTON_BACK,
 SDL_GAMEPAD_BUTTON_LEFT_STICK, SDL_GAMEPAD_BUTTON_RIGHT_STICK, SDL_GAMEPAD_BUTTON_SOUTH,
 SDL_GAMEPAD_BUTTON_EAST, SDL_GAMEPAD_BUTTON_WEST, SDL_GAMEPAD_BUTTON_NORTH,
 SDL_GAMEPAD_BUTTON_LEFT_SHOULDER, SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER } SDL_GamepadButton;
enum { SDL_GAMEPAD_AXIS_LEFTX, SDL_GAMEPAD_AXIS_LEFTY, SDL_GAMEPAD_AXIS_RIGHTX,
 SDL_GAMEPAD_AXIS_RIGHTY, SDL_GAMEPAD_AXIS_LEFT_TRIGGER, SDL_GAMEPAD_AXIS_RIGHT_TRIGGER };
typedef struct { WORD wButtons; BYTE bAnalogButtons[8]; SHORT sThumbLX,sThumbLY,sThumbRX,sThumbRY; } XINPUT_GAMEPAD;
typedef struct { DWORD dwPacketNumber; XINPUT_GAMEPAD Gamepad; } XINPUT_STATE, *PXINPUT_STATE;
typedef struct { SDL_JoystickID id; SHORT axes[6]; BYTE buttons[14]; } SDL_Gamepad;
struct platform_input_state { BYTE keys[64],mouse_buttons[8]; float mouse_dx,mouse_dy,mouse_wheel; int mouse_released,ui_pointer; };
struct controller { BOOL open; DWORD packet_number; XINPUT_GAMEPAD previous; };
static struct controller controllers[4],keyboard_device;
static struct platform_input_state physical_input;
static SDL_Gamepad pads[4];
static int pad_count,console_active,bot_enabled;
static Uint64 ticks,wheel_moved_ms,wheel_press_until_ms;
static pthread_mutex_t mouse_lock=PTHREAD_MUTEX_INITIALIZER;
static float mouse_pending_x,mouse_pending_y,mouse_wheel_accumulated;
static unsigned long mouse_polls_unconsumed;
static struct halo_aim_look_state aim_look_states[4];
static SDL_JoystickID aim_gamepad_ids[4];
static BOOL aim_gamepad_identity_known[4],aim_look_states_initialized;
static unsigned keyboard_movement_axes[4];
static int test_input_holding_action;
static Uint64 test_input_holding_action_since;
static Uint64 SDL_GetTicks(void) { return ticks; }
#ifdef HALO_WEB
static volatile double web_press_until[2];
static double emscripten_get_now(void) { return (double)ticks; }
#endif
static SDL_JoystickID SDL_GetGamepadID(SDL_Gamepad *p) { return p->id; }
static int SDL_GetGamepadButton(SDL_Gamepad *p, SDL_GamepadButton b) { return p->buttons[b]; }
static SHORT SDL_GetGamepadAxis(SDL_Gamepad *p, int a) { return p->axes[a]; }
static const char *config_string(const char *key) { (void)key; return bot_enabled ? "bot:0" : ""; }
static void platform_pump_events(void) {}
static void platform_input_read(struct platform_input_state *out,int consume) { (void)consume; *out=physical_input; }
static int sdl_gamepads(SDL_Gamepad **out) { for(int i=0;i<pad_count;i++)out[i]=&pads[i]; return pad_count; }
static int console_is_active(void) { return console_active; }
static int gamepad_index_for_port(int p) { return p; }
static void wheel_update(void) {}
static void SetLastError(int error) { (void)error; }
#include "xinput_movement.inc"
#include "dead_zone.inc"
#include "stick_constants.inc"
enum { _joystick_controls_default, _joystick_controls_southpaw, _joystick_controls_legacy, _joystick_controls_legacy_southpaw };
enum { _gamepad_binary_button_dpad_up=8, _gamepad_binary_button_dpad_down,
 _gamepad_binary_button_dpad_left, _gamepad_binary_button_dpad_right,
 _gamepad_binary_button_start, _gamepad_binary_button_back,
 _gamepad_binary_button_left_thumb, _gamepad_binary_button_right_thumb };
enum { _gamepad_stick_left, _gamepad_stick_right, NUMBER_OF_GAME_CONTROLS=12 };
struct gamepad_state { BYTE buttons[16]; struct {short x,y;} sticks[2]; };
struct game_input_state { BYTE buttons[12]; real forward_movement,strafe,yaw,pitch; };
static struct gamepad_state gamepad_states[4];
static struct { struct { BYTE game_control_to_xbox_buttons[12]; short joystick_controls; int invert_look,invert_look_aircraft_control; } player_control_preferences[4]; } input_abstraction_globals;
static const struct gamepad_state *input_get_gamepad_state(short p) { return controllers[p].open ? &gamepad_states[p] : NULL; }
static real arctangent(real y,real x) { return atan2f(y,x); }
static real sine(real x) { return sinf(x); }
static real cosine(real x) { return cosf(x); }
static real square_root(real x) { return sqrtf(x); }
static int local_player_is_piloting_aircraft(short p) { (void)p; return 0; }
#define _error_silent 0
static void error(int level,const char *message) { (void)level; (void)message; }
static real const gamepad_axis_normalization_scale=1.f/SHORT_MAX;
static real const stick_direction_angles[]={ STICK_DIAGONAL_ANGLE,STICK_SECOND_QUADRANT_DIAGONAL_ANGLE,-STICK_DIAGONAL_ANGLE,-STICK_SECOND_QUADRANT_DIAGONAL_ANGLE };
#include "movement_policy.inc"
static struct game_input_state poll(int controller_index)
{
 XINPUT_STATE s;
 REQUIRE(XInputGetState(&controllers[controller_index],&s)==0,"production poll connected");
 struct gamepad_state *g=&gamepad_states[controller_index];
 memset(g,0,sizeof(*g));
 for(int i=0;i<8;i++)g->buttons[i]=s.Gamepad.bAnalogButtons[i];
 for(int i=0;i<8;i++)g->buttons[8+i]=(s.Gamepad.wButtons & (1u<<i))!=0;
 g->sticks[0].x=fix_dead_zone(s.Gamepad.sThumbLX,9000);
 g->sticks[0].y=fix_dead_zone(s.Gamepad.sThumbLY,9000);
 g->sticks[1].x=fix_dead_zone(s.Gamepad.sThumbRX,9000);
 g->sticks[1].y=fix_dead_zone(s.Gamepad.sThumbRY,9000);
 const struct gamepad_state *gamepad=g;
 struct game_input_state result={0},*state=&result;
 struct {real x,y;} left_stick,right_stick;
 real left_angle,right_angle;
 long control_index;
 boolean invert_look;
 #include "movement_mapping.inc"
 ticks+=16;
 return result;
}
struct vector2 { real i,j; };
static real magnitude_squared2d(const struct vector2 *v);
struct biped_datum { struct { unsigned flags; real crouch; } biped; struct { struct vector2 throttle; real body_stun; struct {int base_seat_index;} animation; } unit; };
enum { _biped_airborne_bit, _unit_control_crouch_modifier_bit, _button_crouch=10, _unit_base_seat_alert=1 };
static int controls_enable_crouch;
static int crouch(short gamepad_index,struct game_input_state state,int held,int airborne,int is_biped)
{
 struct biped_datum object={0},*biped=is_biped ? &object : NULL;
 struct { struct vector2 throttle; unsigned unit_control_flags; } value={{state.forward_movement,state.strafe},0},*input=&value;
 BYTE effective_buttons[12]={0}; effective_buttons[_button_crouch]=held;
 object.biped.flags=airborne ? (1u<<_biped_airborne_bit) : 0;
 (void)gamepad_index;
 #include "player_crouch.inc"
 return TEST_FLAG(input->unit_control_flags,_unit_control_crouch_modifier_bit);
}
static real speed(struct game_input_state state,real amount)
{
 struct biped_datum object={0},*biped=&object;
 object.biped.crouch=amount; object.unit.throttle.i=state.forward_movement; object.unit.throttle.j=state.strafe;
 /* Illustrative tag fixture values, not measurements from proprietary maps. */
 struct {real stun_movement_penalty,sneak_backward_speed,run_backward_speed,sneak_forward_speed,run_forward_speed,
 run_sideways_speed,sneak_sideways_speed,run_acceleration,sneak_acceleration,walking_speed;} info={0,1,3,1.5f,4,3,1,1,.5f,.5f},*player_information=&info;
 struct {real acceleration_maximum; struct {real i,j,k;} movement_desired;} physics;
 real crouch,uncrouch,stun_scale,forward_speed,sideways_speed,acceleration;
 real body_stun_scale=1,movement_scale=1;
 #include "biped_speed.inc"
 return sqrtf(physics.movement_desired.i*physics.movement_desired.i+physics.movement_desired.j*physics.movement_desired.j);
}
static real magnitude_squared2d(const struct vector2 *v) { return v->i*v->i+v->j*v->j; }
static void neutral(void) { memset(&physical_input,0,sizeof(physical_input)); memset(pads,0,sizeof(pads)); for(int p=0;p<4;p++)pads[p].id=11+p; console_active=0; }
int main(int argc,char **argv)
{
 int xbox=argc>1 && !strcmp(argv[1],"--xbox");
 bot_enabled=argc>1 && !strcmp(argv[1],"--bot");
 for(int p=0;p<4;p++) {
  REQUIRE(XInputOpen(XDEVICE_TYPE_GAMEPAD,p,0,NULL)==&controllers[p],"production open port");
  for(int b=0;b<12;b++)input_abstraction_globals.player_control_preferences[p].game_control_to_xbox_buttons[b]=b;
  /* Default production crouch binding is left-stick click (binary index 14). */
  input_abstraction_globals.player_control_preferences[p].game_control_to_xbox_buttons[_button_crouch]=_gamepad_binary_button_left_thumb;
 }
 neutral();
 if(bot_enabled) {
  physical_input.keys[SDL_SCANCODE_W]=1;
  struct game_input_state state=poll(0);
  REQUIRE(halo_linux_keyboard_movement_axes(0)==0,"synthetic axes revoke keyboard provenance");
  REQUIRE(!input_abstraction_keyboard_crouch_enabled(0,state.forward_movement,state.strafe),"synthetic movement is not keyboard");
  REQUIRE(!halo_linux_camera_assist_enabled(0),"synthetic look does not change #14 ownership");
  test_input_hold_action(1); state=poll(0);
  REQUIRE(halo_linux_keyboard_movement_axes(0)==HALO_KEYBOARD_MOVEMENT_Y,"synthetic action-only does not replace physical movement");
  test_input_hold_action(0);
  puts("PASS: production synthetic bot movement/action provenance and preserved #14 look ownership"); return 0;
 }
 if(!xbox) {
  physical_input.keys[SDL_SCANCODE_LCTRL]=1;
  struct game_input_state binding=poll(0);
#ifdef HALO_WEB
  REQUIRE(!binding.buttons[_button_crouch],"web Ctrl remains a browser shortcut, C is crouch");
#else
  REQUIRE(binding.buttons[_button_crouch],"native Ctrl crouch binding preserved");
#endif
  for(int x=-1;x<=1;x++)for(int y=-1;y<=1;y++)if(x||y) {
   neutral(); physical_input.keys[x<0?SDL_SCANCODE_A:SDL_SCANCODE_D]=x!=0;
   physical_input.keys[y<0?SDL_SCANCODE_S:SDL_SCANCODE_W]=y!=0;
   physical_input.keys[SDL_SCANCODE_C]=1;
   struct game_input_state state=poll(0);
   REQUIRE(crouch(0,state,state.buttons[_button_crouch],0,1),"keyboard crouch direction");
   REQUIRE(speed(state,1)<speed(state,0),"production sneak blend slower than run");
   REQUIRE(speed(state,.5f)>speed(state,1) && speed(state,.5f)<speed(state,0),"production crouch transition blend");
   physical_input.keys[SDL_SCANCODE_C]=0;state=poll(0);
   REQUIRE(!crouch(0,state,state.buttons[_button_crouch],0,1),"keyboard crouch release");
  }
 }
 /* Controller parity across every port, direction, diagonal and partial stick. */
 pad_count=4;
 for(int p=0;p<4;p++)for(int x=-1;x<=1;x++)for(int y=-1;y<=1;y++)if(x||y) {
  neutral(); pads[p].axes[SDL_GAMEPAD_AXIS_LEFTX]=x*(y?23169:32767);
  pads[p].axes[SDL_GAMEPAD_AXIS_LEFTY]=-y*(x?23169:32767);
  pads[p].buttons[SDL_GAMEPAD_BUTTON_LEFT_STICK]=1;
  struct game_input_state full=poll(p);
  REQUIRE(!crouch(p,full,1,0,1),"controller full cancels on every port");
  REQUIRE(crouch(p,full,1,1,1),"airborne crouch unchanged");
  REQUIRE(!crouch(p,full,0,1,1),"airborne release unchanged");
  controls_enable_crouch=1; REQUIRE(crouch(p,full,1,0,1),"existing debug switch"); controls_enable_crouch=0;
  REQUIRE(!crouch(p,full,1,1,0),"non-biped unchanged");
  pads[p].axes[SDL_GAMEPAD_AXIS_LEFTX]/=2;pads[p].axes[SDL_GAMEPAD_AXIS_LEFTY]/=2;
  struct game_input_state partial=poll(p);
  REQUIRE(crouch(p,partial,1,0,1),"controller partial retains crouch");
  REQUIRE(!crouch(p,partial,0,0,1),"controller crouch release");
 }
 if(xbox) { neutral();pad_count=0;physical_input.keys[SDL_SCANCODE_W]=1;struct game_input_state state=poll(0);
  REQUIRE(!crouch(0,state,1,0,1),"non-port Xbox block unchanged");puts("PASS: non-HALO_LINUX crouch block, controller full/partial/release/airborne/debug parity");return 0; }
 neutral();pad_count=1;physical_input.mouse_dx=2;pads[0].axes[SDL_GAMEPAD_AXIS_LEFTY]=-32768;
 struct game_input_state state=poll(0);
 REQUIRE(!halo_linux_camera_assist_enabled(0) && !crouch(0,state,1,0,1),"mouse look plus controller movement keeps Xbox rule");
 physical_input.mouse_dx=0;pads[0].axes[SDL_GAMEPAD_AXIS_RIGHTX]=16000;pads[0].axes[SDL_GAMEPAD_AXIS_LEFTY]=0;
 physical_input.keys[SDL_SCANCODE_W]=1;state=poll(0);
 REQUIRE(halo_linux_camera_assist_enabled(0) && crouch(0,state,1,0,1),"controller look plus keyboard movement crouches");
 physical_input.keys[SDL_SCANCODE_S]=1;pads[0].axes[SDL_GAMEPAD_AXIS_LEFTY]=-32768;state=poll(0);
 REQUIRE(halo_linux_keyboard_movement_axes(0)==0 && !crouch(0,state,1,0,1),"opposing keys plus controller full do not bypass");
 pads[0].axes[SDL_GAMEPAD_AXIS_LEFTY]=0;physical_input.keys[SDL_SCANCODE_A]=1;physical_input.keys[SDL_SCANCODE_D]=1;state=poll(0);
 REQUIRE(halo_linux_keyboard_movement_axes(0)==0 && state.forward_movement==0 && state.strafe==0,"all opposing keys cancel");
 REQUIRE(crouch(0,state,1,0,1) && !crouch(0,state,0,0,1),"stationary crouch and release");
 neutral();physical_input.keys[SDL_SCANCODE_W]=1;pads[0].axes[SDL_GAMEPAD_AXIS_LEFTX]=18000;state=poll(0);
 REQUIRE(halo_linux_keyboard_movement_axes(0)==HALO_KEYBOARD_MOVEMENT_Y && crouch(0,state,1,0,1),"mixed keyboard forward/controller partial strafe");
 REQUIRE(input_abstraction_keyboard_crouch_enabled(0,1,.979f) &&
  !input_abstraction_keyboard_crouch_enabled(0,1,.98f),"mixed contribution preserves exact Xbox cutoff");
 pads[0].axes[SDL_GAMEPAD_AXIS_LEFTX]=32767;state=poll(0);
 REQUIRE(!crouch(0,state,1,0,1),"mixed axis full controller still cancels");
 neutral();physical_input.keys[SDL_SCANCODE_D]=1;pads[0].axes[SDL_GAMEPAD_AXIS_LEFTY]=-18000;state=poll(0);
 REQUIRE(crouch(0,state,1,0,1),"mixed keyboard strafe/controller partial forward");
 pads[0].axes[SDL_GAMEPAD_AXIS_LEFTY]=-32768;state=poll(0);
 REQUIRE(!crouch(0,state,1,0,1),"mixed controller full forward cancels");
 neutral();physical_input.keys[SDL_SCANCODE_W]=1;physical_input.keys[SDL_SCANCODE_D]=1;pads[0].axes[SDL_GAMEPAD_AXIS_LEFTX]=32767;state=poll(0);
 REQUIRE(halo_linux_keyboard_movement_axes(0)==HALO_KEYBOARD_MOVEMENT_Y,"controller overrides stronger diagonal axis");
 REQUIRE(!crouch(0,state,1,0,1),"overridden diagonal retains controller cancellation");
 neutral();physical_input.keys[SDL_SCANCODE_W]=1;pads[0].axes[SDL_GAMEPAD_AXIS_LEFTY]=-32768;state=poll(0);
 REQUIRE(halo_linux_keyboard_movement_axes(0)==HALO_KEYBOARD_MOVEMENT_Y && crouch(0,state,1,0,1),"equal magnitude tie keeps existing keyboard winner");
 physical_input.keys[SDL_SCANCODE_W]=0;DWORD packet=controllers[0].packet_number;state=poll(0);
 REQUIRE(packet==controllers[0].packet_number && !crouch(0,state,1,0,1),"provenance refreshes even when packet/axes unchanged");
 neutral();physical_input.keys[SDL_SCANCODE_W]=1;poll(0);physical_input.ui_pointer=1;state=poll(0);
 REQUIRE(!input_abstraction_keyboard_crouch_enabled(0,state.forward_movement,state.strafe),"menu clears keyboard bypass");
 physical_input.ui_pointer=0;console_active=1;state=poll(0);
 REQUIRE(halo_linux_keyboard_movement_axes(0)==0 && state.forward_movement==0,"console suppresses keyboard movement");
 pads[0].axes[SDL_GAMEPAD_AXIS_LEFTY]=-32768;state=poll(0);
 REQUIRE(!crouch(0,state,1,0,1),"console cannot grant controller full-stick bypass");
 pads[0].axes[SDL_GAMEPAD_AXIS_LEFTY]=-18000;state=poll(0);
 REQUIRE(crouch(0,state,1,0,1),"console leaves controller partial-stick crouch intact");
 console_active=0;pad_count=0;state=poll(0);REQUIRE(crouch(0,state,1,0,1),"unplugged controller retains current keyboard movement");
 pad_count=4;physical_input.keys[SDL_SCANCODE_W]=0;pads[0].id=90;pads[0].axes[SDL_GAMEPAD_AXIS_LEFTY]=-32768;state=poll(0);
 REQUIRE(!crouch(0,state,1,0,1),"hotplug full controller cannot inherit keyboard bypass");
 physical_input.keys[SDL_SCANCODE_W]=1;poll(0);
 for(int p=1;p<4;p++) {pads[p].axes[SDL_GAMEPAD_AXIS_LEFTY]=-32768;state=poll(p);REQUIRE(!crouch(p,state,1,0,1),"port 0 keyboard cannot leak to other ports");}
 REQUIRE(halo_linux_keyboard_movement_axes(0)==HALO_KEYBOARD_MOVEMENT_Y,"other port polls do not reset port 0");
 /* Preferences and D-pad overrides must use effective movement, not raw WASD. */
 neutral();physical_input.keys[SDL_SCANCODE_W]=1;physical_input.keys[SDL_SCANCODE_D]=1;poll(0);
 for(int mode=0;mode<4;mode++) {
  input_abstraction_globals.player_control_preferences[0].joystick_controls=mode;
  REQUIRE(input_abstraction_keyboard_crouch_enabled(0,1,0)==(mode==0||mode==2),"forward preset provenance");
  REQUIRE(input_abstraction_keyboard_crouch_enabled(0,0,1)==(mode==0||mode==3),"strafe preset provenance");
 }
 input_abstraction_globals.player_control_preferences[0].joystick_controls=0;
 gamepad_states[0].buttons[_gamepad_binary_button_dpad_up]=1;gamepad_states[0].buttons[_gamepad_binary_button_dpad_left]=1;
 REQUIRE(!input_abstraction_keyboard_crouch_enabled(0,1,1),"D-pad overrides revoke raw WASD provenance");
 REQUIRE(!input_abstraction_keyboard_crouch_enabled(0,0,0),"zero effective movement has no source");
 REQUIRE(halo_linux_keyboard_movement_axes(-1)==0 && halo_linux_keyboard_movement_axes(4)==0,"invalid port safe");
 REQUIRE(!input_abstraction_keyboard_crouch_enabled(-1,1,0) && !input_abstraction_keyboard_crouch_enabled(4,1,0),"invalid abstraction port safe");
 XInputClose(&controllers[0]);REQUIRE(halo_linux_keyboard_movement_axes(0)==0,"close resets source");
 REQUIRE(!input_abstraction_keyboard_crouch_enabled(0,1,0),"closed controller cannot bypass");
 XInputOpen(XDEVICE_TYPE_GAMEPAD,0,0,NULL);REQUIRE(halo_linux_keyboard_movement_axes(0)==0,"reopen resets source");
 puts("PASS: production WASD forward/back/strafe/diagonal/release; sneak speed and transition blend; controller full/partial; mixed look and movement/axes; cancellation/idle; unchanged-packet provenance; menus/console/hotplug/lifecycle; all ports/presets/D-pad/debug/airborne");
 return 0;
}
