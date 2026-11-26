@echo off
setlocal
set "MORSE_VS="
for /f "usebackq delims=" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "MORSE_VS=%%i"
if not defined MORSE_VS exit /b 2
call "%MORSE_VS%\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 -no_logo
if errorlevel 1 exit /b 2
if exist "%MORSE_VS%\VC\Tools\Llvm\x64\bin\clang-cl.exe" set "PATH=%MORSE_VS%\VC\Tools\Llvm\x64\bin;%PATH%"
cd /d "%MORSE_OBJECTS%"
if errorlevel 1 exit /b 2
clang-cl /nologo /std:c17 /MT /O2 /W3 /D_USE_MATH_DEFINES /D_WIN32_WINNT=0x0A00 /c "%MORSE_SOURCE%\Windows\Converter.c" "%MORSE_SOURCE%\MorseTyping.c" "%MORSE_SOURCE%\Sidetone.c"
if errorlevel 1 exit /b 1
if "%MORSE_CHECK%"=="1" (
  clang-cl /nologo /std:c17 /MT /O2 /W3 /D_USE_MATH_DEFINES "%MORSE_SOURCE%\tests\WindowsConverter.c" Converter.obj MorseTyping.obj Sidetone.obj /Fe"%MORSE_BINARY%"
) else (
  cl /nologo /std:c++20 /utf-8 /EHsc /MT /O2 /W3 /DUNICODE /D_UNICODE /DNOMINMAX /D_WIN32_WINNT=0x0A00 "%MORSE_SOURCE%\Windows\PaddleService.cpp" "%MORSE_SOURCE%\Windows\Wasapi.cpp" Converter.obj MorseTyping.obj Sidetone.obj /Fe"%MORSE_BINARY%" /link windowsapp.lib ole32.lib uuid.lib propsys.lib avrt.lib user32.lib
)
exit /b %errorlevel%
