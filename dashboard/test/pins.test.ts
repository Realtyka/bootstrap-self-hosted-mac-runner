import { describe, it, expect } from 'vitest';
import { parsePins } from '../src/server/pins.js';

const header = `
REQUIRED_XCODE_VERSION="26.0"
REQUIRED_NODE_VERSION="22.12.0"
REQUIRED_RUBY_VERSION="3.1.2"
REQUIRED_COCOAPODS_VERSION="1.16.2"
REQUIRED_IOS_SIM_RUNTIME_NAME="iOS 26.0"
REQUIRED_SIM_DEVICE_TYPE="iPhone 17 Pro"
`;

describe('parsePins', () => {
  it('extracts all pins', () => {
    expect(parsePins(header)).toEqual({
      xcode: '26.0', node: '22.12.0', ruby: '3.1.2',
      cocoapods: '1.16.2', simRuntime: 'iOS 26.0', simDevice: 'iPhone 17 Pro',
    });
  });
  it('throws when a pin is missing', () => {
    expect(() => parsePins('REQUIRED_XCODE_VERSION="26.0"')).toThrow(/REQUIRED_NODE_VERSION/);
  });
});
