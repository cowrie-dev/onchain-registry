import {
  connectViem,
  getResolverContract,
  loadResolverDeployment,
} from "../utils/resolver.js";

const { viem, chainId } = await connectViem();
const deployment = await loadResolverDeployment(chainId);
const resolver = await getResolverContract(viem, deployment.address);

const events = await resolver.getEvents.AttesterTrusted({}, { fromBlock: 0n });
const candidates = new Set<string>();
for (const event of events) {
  if (event.args.attester) candidates.add(event.args.attester.toLowerCase());
}

const entries: Array<{ attester: string; trusted: boolean }> = [];
for (const candidate of candidates) {
  const trusted = await resolver.read.trustedAttesters([candidate as `0x${string}`]);
  if (trusted) {
    entries.push({ attester: candidate, trusted: true });
  }
}

console.log(JSON.stringify({ resolver: deployment.address, trustedAttesters: entries }, null, 2));
