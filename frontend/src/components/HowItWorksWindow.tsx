// Window 3: the argument. Static text from the design, with the real factory address. The
// repository link is left out until there is a URL (nothing invented here).

import { FACTORY } from '../lib/config';

export function HowItWorksWindow() {
  return (
    <div className="window-body--document bevel-groove window-body--scroll">
      <div className="document">
        <div className="doc-heading">What this is</div>
        <p className="doc-text">
          An Intelligent Contract on GenLayer that checks whether an AI agent behaves consistently
          with the capability tier it claims, and writes the result on-chain as a certificate.
        </p>
        <p className="doc-text">
          Litmus does not measure an agent's general intelligence. It verifies whether an agent's
          behavior on a calibrated probe set is consistent with the capability tier it claims.
        </p>

        <div className="doc-heading">How a verification works</div>
        <div className="flow-diagram">
          <div className="flow-box bevel-raised">
            <div className="flow-box-title">1. Probes are generated</div>
            <div className="flow-box-text">
              Nine probes are written in prose from a pool of five templates: transfers between
              people, chained schedules, who did what, finishing order and stock changes. The seed
              comes from the run() transaction itself, so nobody, the agent owner included, can
              know the probes before they are sent.
            </div>
          </div>
          <div className="flow-arrow"><img src="/assets/arrow-right.svg" width="16" height="16" alt="" /></div>
          <div className="flow-box bevel-raised">
            <div className="flow-box-title">2. Validators probe the agent</div>
            <div className="flow-box-text">
              Every validator sends the probes to the agent on its own and grades the answers in
              code. No LLM judges the answers.
            </div>
          </div>
          <div className="flow-box bevel-raised">
            <div className="flow-box-title">3. Validators vote</div>
            <div className="flow-box-text">Validators vote. Consensus needs 3 of 5.</div>
          </div>
          <div className="flow-arrow"><img src="/assets/arrow-right.svg" width="16" height="16" alt="" /></div>
          <div className="flow-box bevel-raised">
            <div className="flow-box-title">4. Certificate is written</div>
            <div className="flow-box-text">The verdict and the evidence are stored on-chain as a certificate.</div>
          </div>
        </div>

        <div className="doc-heading">What a verdict means</div>
        <p className="doc-text">
          CONSISTENT means "consistent with" the claimed tier, not proof of which model runs the
          agent. No black-box test can prove identity: an agent that forwards the probes to a strong
          model passes. INCONSISTENT is informative: the agent claims a tier and fails what that
          tier does not fail.
        </p>

        <div className="doc-heading">The verdict is a statistical test</div>
        <p className="doc-text">
          CONSISTENT if at least 7 of the 9 probes pass, INCONSISTENT if 4 or fewer pass, and
          INCONCLUSIVE in between. The thresholds come from 100 measured probes per template and
          model, checked with the upper bound of a 95 % interval: a strong model (Llama 3.3 70B) is
          INCONSISTENT in fewer than 0.1 % of verifications and CONSISTENT in at least 97 %; a small
          one (Llama 3.2 3B) is CONSISTENT in fewer than 1 %.
        </p>

        <div className="doc-heading">A script cannot pass</div>
        <p className="doc-text">
          Agent E is a script with no model behind it. It solved every probe of the first probe set
          (24 of 24), which is why that set was replaced. Against the current set it answered 0 of 9
          in each of the 16 rounds of the calibration: INCONSISTENT every time.
        </p>

        <div className="doc-heading">Why consensus, and not one server</div>
        <p className="doc-text">
          Models are not deterministic, even at temperature 0 with the provider fixed (measured
          during calibration). A single server would see one answer and could be lucky or unlucky.
          Five validators vote and the leader's result needs 3 of 5, so that variation is tolerated.
        </p>

        <div className="doc-heading">A dissenting vote is the system working</div>
        <p className="doc-text">
          If one validator sees a different verdict and the rest agree, the verdict stands. That is
          the variation consensus is there to absorb.
        </p>

        <div className="doc-heading">Strict format is part of the test</div>
        <p className="doc-text">
          Each probe asks for only one value: an integer, a name or a time in HH:MM. An agent that
          buries the right answer in its working does not pass that probe.
        </p>

        <div className="doc-heading">Limits</div>
        <p className="doc-text">
          The certificate describes one verification, not a permanent guarantee. The agent can see
          it is being tested, and an endpoint that recognizes the verification payload can route only
          that traffic to a stronger model. Anyone can create a verification against any https
          endpoint and anyone can call run(); each verification makes 54 calls to that model, paid by
          the endpoint owner, so a public endpoint should rate limit. The templates are public: a solver written for exactly these templates
          is out of scope (the prose makes it expensive, not impossible). Part of the gap in the
          schedule template comes from format: the small model wrote its final line in only 8 of 100
          replies; even so, it stays CONSISTENT in at most 0.78 % of verifications. Verdicts:
          CONSISTENT, INCONSISTENT, INCONCLUSIVE. No confidence score.
        </p>

        <div className="doc-rule"></div>

        <div className="doc-heading">About</div>
        <p className="doc-text doc-text--last">
          Built on GenLayer (Studio Next, chain 61997). Preset agents via OpenRouter, each on one
          fixed provider: Llama 3.3 70B on CoreWeave and Llama 3.2 3B on Cloudflare; Agent E is a
          script. Every call is signed by your own wallet and pays its GEN fees.
        </p>
        <div className="about-links">
          <span className="about-author">Factory contract: <strong className="prop-value--hash">{FACTORY}</strong></span>
        </div>
      </div>
    </div>
  );
}
