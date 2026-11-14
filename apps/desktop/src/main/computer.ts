import { desktopCapturer, screen } from 'electron';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { parseComputerAction, type ComputerAction } from '../../../../packages/agent-runtime/src/computer-tool';

const WINDOWS_INPUT_HELPER = String.raw`
using System;
using System.Runtime.InteropServices;

public static class JinggongDesktopInput {
    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput { public int X; public int Y; public uint MouseData; public uint Flags; public uint Time; public UIntPtr ExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput { public ushort VirtualKey; public ushort Scan; public uint Flags; public uint Time; public UIntPtr ExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyboardInput Keyboard; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Input { public uint Type; public InputUnion Data; }

    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, Input[] inputs, int size);
    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint MOUSE_LEFT_DOWN = 0x0002, MOUSE_LEFT_UP = 0x0004;
    private const uint MOUSE_RIGHT_DOWN = 0x0008, MOUSE_RIGHT_UP = 0x0010;
    private const uint MOUSE_MIDDLE_DOWN = 0x0020, MOUSE_MIDDLE_UP = 0x0040;
    private const uint MOUSE_WHEEL = 0x0800;
    private const uint KEY_UP = 0x0002, KEY_UNICODE = 0x0004;

    private static void Send(Input[] inputs) {
        if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) != inputs.Length)
            throw new InvalidOperationException("Windows 未接受完整的输入事件");
    }
    private static Input Mouse(uint flags, uint data) {
        return new Input { Type = INPUT_MOUSE, Data = new InputUnion { Mouse = new MouseInput { Flags = flags, MouseData = data } } };
    }
    private static Input Key(ushort key, bool up) {
        return new Input { Type = INPUT_KEYBOARD, Data = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = key, Flags = up ? KEY_UP : 0 } } };
    }
    private static ushort ToVirtualKey(string key) {
        key = key.ToUpperInvariant();
        if (key.Length == 1 && ((key[0] >= 'A' && key[0] <= 'Z') || (key[0] >= '0' && key[0] <= '9'))) return (ushort)key[0];
        if (key.Length >= 2 && key[0] == 'F') { int function; if (Int32.TryParse(key.Substring(1), out function) && function >= 1 && function <= 12) return (ushort)(0x70 + function - 1); }
        switch (key) {
            case "BACKSPACE": return 0x08; case "TAB": return 0x09; case "ENTER": return 0x0D;
            case "CTRL": case "CONTROL": return 0x11; case "ALT": return 0x12; case "PAUSE": return 0x13;
            case "CAPSLOCK": return 0x14; case "ESC": return 0x1B; case "SPACE": return 0x20;
            case "PAGEUP": return 0x21; case "PAGEDOWN": return 0x22; case "END": return 0x23; case "HOME": return 0x24;
            case "LEFT": return 0x25; case "UP": return 0x26; case "RIGHT": return 0x27; case "DOWN": return 0x28;
            case "INSERT": return 0x2D; case "DELETE": return 0x2E; case "SHIFT": return 0x10; case "WIN": case "META": return 0x5B;
            default: throw new ArgumentException("不支持的按键");
        }
    }
    private static bool IsModifier(string key) { key = key.ToUpperInvariant(); return key == "CTRL" || key == "CONTROL" || key == "ALT" || key == "SHIFT" || key == "WIN" || key == "META"; }

    public static void Move(int x, int y) { if (!SetCursorPos(x, y)) throw new InvalidOperationException("Windows 拒绝移动鼠标"); }
    public static void Click(int x, int y, int button, int count) {
        Move(x, y); uint down, up;
        if (button == 0) { down = MOUSE_LEFT_DOWN; up = MOUSE_LEFT_UP; }
        else if (button == 1) { down = MOUSE_RIGHT_DOWN; up = MOUSE_RIGHT_UP; }
        else { down = MOUSE_MIDDLE_DOWN; up = MOUSE_MIDDLE_UP; }
        for (int i = 0; i < count; i++) Send(new Input[] { Mouse(down, 0), Mouse(up, 0) });
    }
    public static void Scroll(int x, int y, int delta) { Move(x, y); Send(new Input[] { Mouse(MOUSE_WHEEL, unchecked((uint)delta)) }); }
    public static void PressKey(string combo) {
        string[] parts = combo.ToUpperInvariant().Split('+');
        for (int i = 0; i < parts.Length - 1; i++) { if (!IsModifier(parts[i])) throw new ArgumentException("组合键只允许修饰键在前"); Send(new Input[] { Key(ToVirtualKey(parts[i]), false) }); }
        ushort last = ToVirtualKey(parts[parts.Length - 1]); Send(new Input[] { Key(last, false), Key(last, true) });
        for (int i = parts.Length - 2; i >= 0; i--) Send(new Input[] { Key(ToVirtualKey(parts[i]), true) });
    }
    public static void TypeText(string text) {
        const int chunkSize = 256;
        for (int start = 0; start < text.Length; start += chunkSize) {
            int length = Math.Min(chunkSize, text.Length - start); Input[] inputs = new Input[length * 2];
            for (int i = 0; i < length; i++) {
                ushort character = text[start + i];
                inputs[i * 2] = new Input { Type = INPUT_KEYBOARD, Data = new InputUnion { Keyboard = new KeyboardInput { Scan = character, Flags = KEY_UNICODE } } };
                inputs[i * 2 + 1] = new Input { Type = INPUT_KEYBOARD, Data = new InputUnion { Keyboard = new KeyboardInput { Scan = character, Flags = KEY_UNICODE | KEY_UP } } };
            }
            Send(inputs);
        }
    }
}`;

const buttonCode: Record<'left' | 'right' | 'middle', number> = { left: 0, right: 1, middle: 2 };

/** 只提供白名单桌面动作；截图仅采集主显示器，输入以 Electron 主进程调用 Windows SendInput。 */
export class ComputerManager {
  async action(input: unknown, signal?: AbortSignal): Promise<{ text: string; imageUrl?: string }> {
    if (process.platform !== 'win32') throw new Error('桌面 computer-use 当前仅支持 Windows');
    if (signal?.aborted) throw new Error('桌面操作已取消');
    const action = parseComputerAction(input);
    if (action.action === 'screenshot') return this.screenshot();
    const display = screen.getPrimaryDisplay();
    if ('x' in action && 'y' in action) {
      const bounds = display.bounds;
      if (action.x < bounds.x || action.y < bounds.y || action.x >= bounds.x + bounds.width || action.y >= bounds.y + bounds.height) throw new Error('坐标超出主显示器范围');
    }
    const coordinate = 'x' in action && 'y' in action ? screen.dipToScreenPoint({ x: action.x, y: action.y }) : undefined;
    const result = await this.sendInput(action, coordinate, signal);
    return { text: result };
  }

  private async screenshot(): Promise<{ text: string; imageUrl: string }> {
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 800 }, fetchWindowIcons: false });
    const source = sources.find(item => item.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined);
    if (!source || source.thumbnail.isEmpty()) throw new Error('无法读取主显示器截图');
    let image = source.thumbnail;
    if (image.toPNG().byteLength > 5 * 1024 * 1024) image = image.resize({ width: 960 });
    const size = image.getSize();
    const bounds = display.bounds;
    const imageUrl = image.toDataURL();
    return {
      imageUrl,
      text: `主显示器截图完成。截图像素为 ${size.width}×${size.height}；操作坐标使用主屏逻辑坐标 bounds x=${bounds.x}, y=${bounds.y}, width=${bounds.width}, height=${bounds.height}。按截图与 bounds 的宽高比例换算坐标，输入会自动换算为 Windows 屏幕坐标。`,
    };
  }

  private async sendInput(action: Exclude<ComputerAction, { action: 'screenshot' }>, point?: { x: number; y: number }, signal?: AbortSignal): Promise<string> {
    let command: string;
    switch (action.action) {
      case 'move': command = `[JinggongDesktopInput]::Move(${point!.x}, ${point!.y})`; break;
      case 'click': command = `[JinggongDesktopInput]::Click(${point!.x}, ${point!.y}, ${buttonCode[action.button]}, 1)`; break;
      case 'double_click': command = `[JinggongDesktopInput]::Click(${point!.x}, ${point!.y}, ${buttonCode[action.button]}, 2)`; break;
      case 'scroll': command = `[JinggongDesktopInput]::Scroll(${point!.x}, ${point!.y}, ${action.deltaY})`; break;
      case 'press': command = `[JinggongDesktopInput]::PressKey('${action.key.toUpperCase()}')`; break;
      case 'type': {
        const encoded = Buffer.from(action.text, 'utf8').toString('base64');
        command = `$value = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); [JinggongDesktopInput]::TypeText($value)`;
        break;
      }
    }
    await this.runPowerShell(command, signal);
    return `已执行桌面操作：${action.action}`;
  }

  private async runPowerShell(command: string, signal?: AbortSignal): Promise<void> {
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${WINDOWS_INPUT_HELPER}\n'@\n${command}`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[key]) env[key] = process.env[key];
    await new Promise<void>((resolve, reject) => {
      execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024, env, signal,
      }, error => error ? reject(new Error(signal?.aborted ? '桌面操作已取消' : 'Windows 桌面输入执行失败')) : resolve());
    });
  }
}
