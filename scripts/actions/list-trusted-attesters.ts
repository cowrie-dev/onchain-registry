import {
  connectViem,
  getResolverContract,
  loadResolverDeployment,
  resolveOption,
  resolveWallet,
} from "../utils/resolver.js";

const fromArg = resolveOption("--from", ["FROM"]);

const { viem, chainId } = await connectViem();
const wallet = await resolveWallet(viem, fromArg);
const deployment = await loadResolverDeployment(chainId);
const resolver = await getResolverContract(viem, deployment.address, wallet);

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
