// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Which IP addresses are public. An address somebody outside the operator's
 * trust names (a user's own model server, a source the administrator types
 * into the panel) is dialled only when it is one: the server is never steered
 * onto the loopback interface, the operator's network or a cloud's metadata
 * service.
 */
import { BlockList, isIP } from 'node:net';

/** Every range that is not a public unicast address. */
const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // this network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including broadcast
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  // Unspecified, loopback and IPv4-compatible addresses. The forms that carry
  // an IPv4 address inside an IPv6 one are refused whole: no server this
  // application calls is reached through them, and each is a way to spell an
  // internal address.
  ['::', 96],
  ['::ffff:0:0:0', 96], // IPv4-translated
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local
  ['ff00::', 8], // multicast
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

/**
 * True for an IP address that is public. An IPv4-mapped IPv6 address
 * (`::ffff:10.0.0.1`) is judged by the IPv4 address it carries.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
