/* Execute production input polling with only platform/SDL boundaries mocked. */
#include <assert.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <pthread.h>
#include "halo_aim_device.h"
#include "halo_movement_source.h"
#define PORT_COUNT 4
#define TRUE 1
#define FALSE 0
#define WINAPI
#define ERROR_DEVICE_NOT_CONNECTED 1
#define ERROR_SUCCESS 0
typedef int BOOL;
typedef unsigned DWORD;
typedef uint64_t Uint64;
typedef unsigned SDL_JoystickID;
typedef void *HANDLE;
typedef struct {short sThumbRX,sThumbRY,sThumbLX,sThumbLY;} XINPUT_GAMEPAD;
typedef struct {DWORD dwPacketNumber; XINPUT_GAMEPAD Gamepad;} XINPUT_STATE, *PXINPUT_STATE;
typedef struct {SDL_JoystickID id; XINPUT_GAMEPAD pad;} SDL_Gamepad;
struct platform_input_state {float mouse_dx,mouse_dy,mouse_wheel; int mouse_released,ui_pointer;};
static struct platform_input_state physical_input;
static SDL_Gamepad pads[4];
static int pad_count, synthetic_look;
static Uint64 ticks;
static pthread_mutex_t mouse_lock=PTHREAD_MUTEX_INITIALIZER;
static float mouse_pending_x,mouse_pending_y,mouse_wheel_accumulated;
static unsigned long mouse_polls_unconsumed;
static Uint64 wheel_moved_ms;
static struct halo_aim_look_state aim_look_states[4];
static SDL_JoystickID aim_gamepad_ids[4];
static BOOL aim_gamepad_identity_known[4],aim_look_states_initialized;
static unsigned keyboard_movement_axes[4];
static struct {DWORD packet_number; XINPUT_GAMEPAD previous;} controllers[4];
static Uint64 SDL_GetTicks(void) {return ticks;}
static SDL_JoystickID SDL_GetGamepadID(SDL_Gamepad *p) {return p->id;}
static float mouse_sensitivity_value=1.f;
static BOOL mouse_invert_value=0;
static void mouse_settings_refresh(void) {}
static void platform_pump_events(void) {}
static void platform_input_read(struct platform_input_state *input,int consume) {(void)consume;*input=physical_input;}
static int sdl_gamepads(SDL_Gamepad **out) {for(int i=0;i<pad_count;i++)out[i]=&pads[i];return pad_count;}
static int controller_port(HANDLE p) {for(int i=0;i<4;i++)if(p==&controllers[i])return i;return -1;}
static int gamepad_index_for_port(int p) {return p;}
static int console_is_active(void) {return 0;}
static void wheel_update(void) {}
static void keyboard_gamepad(const struct platform_input_state *input,XINPUT_GAMEPAD *pad) {(void)input;pad->sThumbLX=32767;}
static void sdl_gamepad_state(SDL_Gamepad *p,XINPUT_GAMEPAD *out) {out->sThumbRX=p->pad.sThumbRX;out->sThumbRY=p->pad.sThumbRY;}
static int test_input_gamepad(XINPUT_GAMEPAD *p) {if(synthetic_look)p->sThumbRX=32767;return 0;}
#include "xinput_aim.inc"
static void poll(int port) {XINPUT_STATE s;assert(XInputGetState(&controllers[port],&s)==0);ticks+=16;}
int main(void)
{
 float yaw,pitch;
 poll(0);assert(!halo_linux_camera_assist_enabled(0)); /* WASD is not look. */
 pad_count=2;pads[0].id=11;pads[1].id=22;
 pads[0].pad.sThumbRX=9001;poll(0);assert(halo_linux_camera_assist_enabled(0));
 pads[0].pad.sThumbRX=0;for(int i=0;i<100;i++)poll(0);
 assert(halo_linux_camera_assist_enabled(0));
 /* Resume camera consumption after idle/menu polls; reset the stale-delta guard. */
 assert(!halo_linux_mouse_look(0,&yaw,&pitch));
 physical_input.mouse_dx=2;poll(0);assert(!halo_linux_camera_assist_enabled(0));
 physical_input.mouse_dx=0;pads[0].pad.sThumbRX=16000;poll(0);
 assert(halo_linux_camera_assist_enabled(0));
 /* Consuming an older pending mouse delta cannot override newer stick input. */
 assert(halo_linux_mouse_look(0,&yaw,&pitch));assert(halo_linux_camera_assist_enabled(0));
 physical_input.mouse_dx=2;poll(0);assert(!halo_linux_camera_assist_enabled(0));
 physical_input.mouse_dx=0;poll(0);assert(!halo_linux_camera_assist_enabled(0));
 poll(1);assert(halo_linux_camera_assist_enabled(1));
 pads[0].pad.sThumbRX=18000;physical_input.ui_pointer=1;physical_input.mouse_dx=2;poll(0);
 assert(halo_linux_camera_assist_enabled(0)); /* Menu pointer isn't mouse look. */
 physical_input.ui_pointer=0;physical_input.mouse_released=1;pads[0].pad.sThumbRX=20000;poll(0);
 assert(halo_linux_camera_assist_enabled(0));
 physical_input.mouse_dx=0;pad_count=0;poll(0);assert(halo_linux_camera_assist_enabled(0));
 physical_input.mouse_released=0;physical_input.mouse_dx=2;poll(0);
 assert(!halo_linux_camera_assist_enabled(0));
 physical_input.mouse_dx=0;pad_count=1;pads[0].id=33;pads[0].pad.sThumbRX=0;poll(0);
 assert(!halo_linux_camera_assist_enabled(0)); /* Neutral hotplug cannot steal look. */
 synthetic_look=1;poll(0);assert(!halo_linux_camera_assist_enabled(0));
 synthetic_look=0;pads[0].pad.sThumbRY=-9001;poll(0);assert(halo_linux_camera_assist_enabled(0));
 assert(halo_linux_camera_assist_enabled(-1));assert(halo_linux_camera_assist_enabled(4));
 assert(!halo_linux_mouse_look(1,&yaw,&pitch));
 puts("PASS: production XInput polling, movement independence, chronological look, mouse consumption, per-port isolation, UI/capture, hotplug, synthetic input");
 return 0;
}
