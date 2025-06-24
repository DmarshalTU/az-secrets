@echo off
REM Azure Secrets Explorer Build Script for Windows
REM This script helps build the application on Windows

setlocal enabledelayedexpansion

REM Colors for output (Windows 10+)
set "BLUE=[94m"
set "GREEN=[92m"
set "YELLOW=[93m"
set "RED=[91m"
set "NC=[0m"

REM Function to print colored output
:print_status
echo %BLUE%[INFO]%NC% %~1
goto :eof

:print_success
echo %GREEN%[SUCCESS]%NC% %~1
goto :eof

:print_warning
echo %YELLOW%[WARNING]%NC% %~1
goto :eof

:print_error
echo %RED%[ERROR]%NC% %~1
goto :eof

REM Check if we're in the right directory
if not exist "package.json" (
    call :print_error "package.json not found. Please run this script from the project root."
    exit /b 1
)

REM Parse arguments
set "clean=false"
set "icons_only=false"
set "deps_only=false"
set "platform="

:parse_args
if "%~1"=="" goto :main
if "%~1"=="-h" goto :show_help
if "%~1"=="--help" goto :show_help
if "%~1"=="-c" (
    set "clean=true"
    shift
    goto :parse_args
)
if "%~1"=="--clean" (
    set "clean=true"
    shift
    goto :parse_args
)
if "%~1"=="-i" (
    set "icons_only=true"
    shift
    goto :parse_args
)
if "%~1"=="--icons" (
    set "icons_only=true"
    shift
    goto :parse_args
)
if "%~1"=="-d" (
    set "deps_only=true"
    shift
    goto :parse_args
)
if "%~1"=="--deps" (
    set "deps_only=true"
    shift
    goto :parse_args
)
set "platform=%~1"
shift
goto :parse_args

:show_help
echo Azure Secrets Explorer Build Script
echo.
echo Usage: %~nx0 [OPTIONS] [PLATFORM]
echo.
echo Options:
echo   -h, --help     Show this help message
echo   -c, --clean    Clean build artifacts before building
echo   -i, --icons    Setup icons only
echo   -d, --deps     Install dependencies only
echo.
echo Platforms:
echo   windows, win   Build for Windows
echo   macos, mac     Build for macOS
echo   linux          Build for Linux
echo   all            Build for all platforms
echo   (none)         Build for current platform
echo.
echo Examples:
echo   %~nx0                    # Build for current platform
echo   %~nx0 windows            # Build for Windows
echo   %~nx0 --clean all        # Clean and build for all platforms
echo   %~nx0 --icons            # Setup icons only
exit /b 0

:setup_icons
call :print_status "Setting up icons for build..."

REM Check if icon.png exists
if not exist "assets\icon.png" (
    call :print_error "assets\icon.png not found! Please add an icon file."
    exit /b 1
)

REM Create Windows icon if needed
if not exist "assets\icon.ico" (
    call :print_warning "Windows icon not found. You'll need to create assets\icon.ico manually."
    call :print_status "You can use online converters or ImageMagick to create the .ico file."
)

REM Create macOS icon placeholder if needed
if not exist "assets\icon.icns" (
    call :print_warning "macOS icon not found. You'll need to create assets\icon.icns manually."
    call :print_status "You can use online converters or macOS tools to create the .icns file."
)

goto :eof

:install_dependencies
call :print_status "Installing dependencies..."

if not exist "node_modules" (
    npm install
) else (
    npm ci
)

call :print_success "Dependencies installed"
goto :eof

:build_current
call :print_status "Building for current platform..."
npm run build
call :print_success "Build completed"
goto :eof

:build_platform
set "platform_name=%~1"
call :print_status "Building for %platform_name%..."

if "%platform_name%"=="windows" (
    npm run build:win
) else if "%platform_name%"=="win" (
    npm run build:win
) else if "%platform_name%"=="macos" (
    npm run build:mac
) else if "%platform_name%"=="mac" (
    npm run build:mac
) else if "%platform_name%"=="linux" (
    npm run build:linux
) else if "%platform_name%"=="all" (
    npm run build:all
) else (
    call :print_error "Unknown platform: %platform_name%"
    call :print_status "Available platforms: windows, macos, linux, all"
    exit /b 1
)

call :print_success "Build completed for %platform_name%"
goto :eof

:clean_build
call :print_status "Cleaning build artifacts..."
if exist "dist" rmdir /s /q "dist"
call :print_success "Build artifacts cleaned"
goto :eof

:main
REM Setup icons
call :setup_icons

if "%icons_only%"=="true" (
    call :print_success "Icons setup completed"
    exit /b 0
)

REM Install dependencies
call :install_dependencies

if "%deps_only%"=="true" (
    call :print_success "Dependencies installation completed"
    exit /b 0
)

REM Clean if requested
if "%clean%"=="true" (
    call :clean_build
)

REM Build
if "%platform%"=="" (
    call :build_current
) else (
    call :build_platform "%platform%"
)

call :print_success "Build process completed successfully!"
call :print_status "Check the 'dist' directory for build outputs."
exit /b 0 