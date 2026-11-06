/**
 * The posture estimate (PENDING P3): one explainable score, the objective cards
 * it is built from, and the ranked list of what to fix first. PRESENTATION
 * ONLY — every figure arrives in the `score` block of `GET /v1/reports/posture`,
 * computed by a fixed, published formula on the server; this file invents no
 * number and does no arithmetic beyond formatting.
 *
 * Honesty rules, rendered: the score is labelled an estimate on its face with
 * its disclaimer visible (never "compliant"), the weights and formulae are one
 * disclosure away, and an objective with no data says unmeasured.
 */
import { Link } from "react-router-dom";
import { Badge, Card, EmptyState, Meter, Table } from "../../../ui/kit";
import v from "../../views.module.css";
import p from "./posture.module.css";

export interface PostureScoreDoc {
  estimate: true;
  score: number;
  scale: { min: number; max: number };
  method: string;
  disclaimer: string;
  objectives: Array<{
    id: string;
    title: string;
    outcome: string;
    metric: { label: string; value: string };
    weight: number;
    measured: boolean;
    score: number;
    contribution: number;
    inputs: Array<{ label: string; value: string }>;
    formula: string;
    link: { to: string; label: string };
  }>;
  actions: Array<{
    key: string;
    rank: number;
    title: string;
    points: number;
    reason: string;
    link: { to: string; label: string };
  }>;
}

type Objective = PostureScoreDoc["objectives"][number];

const points = (x: number) => `${x} ${x === 1 ? "point" : "points"}`;

function ObjectiveCard(props: { o: Objective }) {
  const { o } = props;
  return (
    <Card
      title={o.title}
      infoLabel={o.title}
      info={
        <>
          <p>{o.outcome}</p>
          <p>{o.formula}</p>
        </>
      }
    >
      <div className={v.stack}>
        <div>
          <div className={p.headline}>{o.metric.value}</div>
          <div className={p.oneLiner}>{o.metric.label}</div>
        </div>
        <Meter value={o.score} max={100} warn={o.score < 50} label={`${o.title}: ${o.score} out of 100`} />
        <div className={p.oneLiner}>
          {o.score} of 100 · weight {o.weight}% · adds {points(o.contribution)}{" "}
          {!o.measured && <Badge tone="warn">Unmeasured</Badge>}
        </div>
        <Link to={o.link.to} className={p.sectionLink}>
          {o.link.label}
        </Link>
      </div>
    </Card>
  );
}

export function PostureEstimate(props: { score: PostureScoreDoc }) {
  const s = props.score;
  return (
    <section aria-labelledby="posture-estimate-heading" className={v.stack}>
      <h2 id="posture-estimate-heading" className={p.sectionHeading}>
        Posture estimate
      </h2>
      <div className={v.grid2}>
        <Card
          title={<>Overall <Badge tone="warn">Estimate</Badge></>}
          infoLabel="Posture estimate"
          info={<p>{s.method}</p>}
        >
          <div className={v.stack}>
            <div>
              <span className={p.score}>{s.score}</span>
              <span className={p.oneLiner}> out of {s.scale.max}</span>
            </div>
            <Meter value={s.score} max={s.scale.max} warn={s.score < 50} label={`Posture estimate: ${s.score} out of ${s.scale.max}`} />
            <p className={p.oneLiner}>{s.disclaimer}</p>
            <details className={p.details}>
              <summary>How this is calculated</summary>
              <p className={p.oneLiner}>{s.method}</p>
              <Table
                columns={[
                  { key: "objective", header: "Objective", render: (o: Objective) => o.title },
                  {
                    key: "inputs",
                    header: "Inputs",
                    render: (o: Objective) => (
                      <ul className={p.inputs}>
                        {o.inputs.map((i) => (
                          <li key={i.label}>
                            {i.label}: {i.value}
                          </li>
                        ))}
                      </ul>
                    ),
                  },
                  { key: "formula", header: "Formula", render: (o: Objective) => o.formula },
                  { key: "weight", header: "Weight", align: "right", render: (o: Objective) => `${o.weight}%` },
                  { key: "score", header: "Score", align: "right", render: (o: Objective) => (o.measured ? o.score : `${o.score} (unmeasured)`) },
                  { key: "adds", header: "Adds", align: "right", render: (o: Objective) => o.contribution },
                ]}
                rows={s.objectives}
                rowKey={(o) => o.id}
              />
            </details>
          </div>
        </Card>
        <Card title="What to fix first" infoLabel="What to fix first" info={<p>Ranked by how many points fixing each item would add to the estimate. Equal items keep a fixed order.</p>}>
          {s.actions.length === 0 ? (
            <EmptyState title="Nothing to fix" body="Every objective is at its full score on the records this deployment holds." />
          ) : (
            <ol className={p.actions}>
              {s.actions.map((a) => (
                <li key={a.key}>
                  <div>
                    <strong>{a.title}</strong> <Badge>{`+${points(a.points)}`}</Badge>
                  </div>
                  <div className={p.oneLiner}>{a.reason}</div>
                  <Link to={a.link.to} className={p.sectionLink}>
                    {a.link.label}
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
      <div className={v.grid4}>
        {s.objectives.map((o) => (
          <ObjectiveCard key={o.id} o={o} />
        ))}
      </div>
    </section>
  );
}
