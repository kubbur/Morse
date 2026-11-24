#import "TypingKeys.h"
#import <Carbon/Carbon.h>

static CGKeyCode keyCode(char c) {
    static const CGKeyCode letters[]={kVK_ANSI_A,kVK_ANSI_B,kVK_ANSI_C,kVK_ANSI_D,kVK_ANSI_E,
        kVK_ANSI_F,kVK_ANSI_G,kVK_ANSI_H,kVK_ANSI_I,kVK_ANSI_J,kVK_ANSI_K,kVK_ANSI_L,kVK_ANSI_M,
        kVK_ANSI_N,kVK_ANSI_O,kVK_ANSI_P,kVK_ANSI_Q,kVK_ANSI_R,kVK_ANSI_S,kVK_ANSI_T,kVK_ANSI_U,
        kVK_ANSI_V,kVK_ANSI_W,kVK_ANSI_X,kVK_ANSI_Y,kVK_ANSI_Z};
    static const CGKeyCode digits[]={kVK_ANSI_0,kVK_ANSI_1,kVK_ANSI_2,kVK_ANSI_3,kVK_ANSI_4,
        kVK_ANSI_5,kVK_ANSI_6,kVK_ANSI_7,kVK_ANSI_8,kVK_ANSI_9};
    if (c>='a' && c<='z') return letters[c-'a'];
    if (c>='0' && c<='9') return digits[c-'0'];
    switch (c) {
        case ' ': return kVK_Space;
        case '.': return kVK_ANSI_Period;
        case ',': return kVK_ANSI_Comma;
        case '/': case '?': return kVK_ANSI_Slash;
        case '-': case '_': return kVK_ANSI_Minus;
        case '=': case '+': return kVK_ANSI_Equal;
        case ':': case ';': return kVK_ANSI_Semicolon;
        case '"': case '\'': return kVK_ANSI_Quote;
        case '!': return kVK_ANSI_1;
        case '@': return kVK_ANSI_2;
        case '&': return kVK_ANSI_7;
        case '(': return kVK_ANSI_9;
        case ')': return kVK_ANSI_0;
        default: return UINT16_MAX;
    }
}
bool makeTypingKeys(char character, CGEventRef *down, CGEventRef *up) {
    *down=NULL; *up=NULL;
    CGKeyCode code=keyCode(character);
    if (code==UINT16_MAX) return false;
    CGEventRef press=CGEventCreateKeyboardEvent(NULL,code,true);
    CGEventRef release=CGEventCreateKeyboardEvent(NULL,code,false);
    if (!press || !release) {
        if (press) CFRelease(press);
        if (release) CFRelease(release);
        return false;
    }
    UniChar unicode=(unsigned char)character;
    CGEventSetFlags(press,0); CGEventSetFlags(release,0);
    CGEventKeyboardSetUnicodeString(press,1,&unicode);
    CGEventKeyboardSetUnicodeString(release,1,&unicode);
    *down=press; *up=release;
    return true;
}
bool postTypingKey(pid_t pid, char character) {
    CGEventRef down,up;
    if (pid<=0 || !makeTypingKeys(character,&down,&up)) return false;
    CGEventPostToPid(pid,down); CGEventPostToPid(pid,up);
    CFRelease(down); CFRelease(up); return true;
}
