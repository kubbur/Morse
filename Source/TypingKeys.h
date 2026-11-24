#pragma once
#include <CoreGraphics/CoreGraphics.h>

// The caller owns both events. This function builds the pair without delivering it.
bool makeTypingKeys(char character, CGEventRef *down, CGEventRef *up);
bool postTypingKey(pid_t pid, char character);
