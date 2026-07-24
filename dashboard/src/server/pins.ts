export interface Pins {
  xcode: string; node: string; ruby: string;
  cocoapods: string; simRuntime: string; simDevice: string;
}

const VARS: Record<keyof Pins, string> = {
  xcode: 'REQUIRED_XCODE_VERSION', node: 'REQUIRED_NODE_VERSION',
  ruby: 'REQUIRED_RUBY_VERSION', cocoapods: 'REQUIRED_COCOAPODS_VERSION',
  simRuntime: 'REQUIRED_IOS_SIM_RUNTIME_NAME', simDevice: 'REQUIRED_SIM_DEVICE_TYPE',
};

export function parsePins(scriptText: string): Pins {
  const out = {} as Pins;
  for (const [key, varName] of Object.entries(VARS) as [keyof Pins, string][]) {
    const m = scriptText.match(new RegExp(`^${varName}="([^"]+)"`, 'm'));
    if (!m) throw new Error(`pin not found in bootstrap script: ${varName}`);
    out[key] = m[1];
  }
  return out;
}
