export {
  parseRuntimeCommand as parseCommand,
  safeRuntimePath as safeRelative,
} from '@daban/protocol';

export function trustedSender(
  sender: { url: string; mainFrame: boolean; owned: boolean },
  expected: string,
) {
  return sender.mainFrame && sender.owned && sender.url === expected;
}
