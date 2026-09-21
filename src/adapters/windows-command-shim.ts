export interface WindowsCommandInvocation {
  program: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

function quoteCmdArg(value: string): string {
  const escaped = value.replace(/(["^&|<>%!])/g, '^$1');
  return `"${escaped}"`;
}

export function windowsCommandShim(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): WindowsCommandInvocation {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(program)) {
    return { program, args, windowsVerbatimArguments: false };
  }
  const comspec = env.ComSpec?.trim() || process.env.ComSpec?.trim() || 'cmd.exe';
  const command = [quoteCmdArg(program), ...args.map(quoteCmdArg)].join(' ');
  return {
    program: comspec,
    args: ['/d', '/s', '/c', `"${command}"`],
    windowsVerbatimArguments: true
  };
}
