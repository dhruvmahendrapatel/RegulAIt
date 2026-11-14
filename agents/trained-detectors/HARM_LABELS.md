# Harm labels (ADR-0247)

The harm detector reports its findings under RegulAIt's own labels, defined here. The gateway turns each label into a
count named `trained_<label>` under the `toxicity` guardrail category (ADR-0220 §4, §7); no text from the request is
ever reported. These definitions are written for RegulAIt. Public hazard taxonomies, including the one published with
Llama Guard, were read for coverage only; no wording was taken from them.

## Labels the reference classifier reports

The reference service maps each output of `unitary/toxic-bert` to one of these labels (`detector_core.HARM_LABELS`). A
label counts as a reason when its probability reaches 0.5; the detector's score is the highest probability of any
label, compared with the admin's threshold.

| Label | Definition | Model output it comes from |
|---|---|---|
| `toxicity` | Language that is rude, disrespectful or hostile enough that a reasonable reader would want to leave the conversation. The broadest label; most other labels also raise it. | `toxic` |
| `severe_toxicity` | Hostility at the extreme end: sustained, vicious or degrading abuse, not just rudeness. | `severe_toxic` |
| `obscenity` | Vulgar, crude or sexually explicit wording used offensively. Clinical or educational language about bodies or sex is not this label. | `obscene` |
| `violent_threat` | A statement that the speaker, or someone else, will or should physically hurt a person or group, or wishes them dead or injured. | `threat` |
| `harassment` | Insults, name-calling or demeaning remarks aimed at a specific person or the reader. | `insult` |
| `hate` | Content that attacks or dehumanises people because of a protected characteristic, such as race, ethnicity, religion, nationality, sex, gender identity, sexual orientation or disability. | `identity_hate` |

## Labels reserved for future classifiers

The reference classifier does not detect these; a scorer that does should report them under these names so the counts
line up across scorers.

| Label | Definition |
|---|---|
| `self_harm` | Encouragement of, or instructions for, suicide, self-injury or disordered eating. |
| `sexual_minors` | Any sexual content involving a person under 18. |
| `violent_crime` | Help planning or carrying out violence against people, such as assault, kidnapping or terrorism. |
| `nonviolent_crime` | Help committing fraud, theft, hacking or other crimes without direct physical violence. |
| `weapons_mass_harm` | Help building or deploying chemical, biological, radiological, nuclear or high-yield explosive weapons. |
| `privacy_exposure` | Revealing non-public personal information about a real, identifiable person. (The PII detector covers identifiers; this label is for disclosures it would not recognise.) |
| `defamation` | False statements of fact about a real person or organisation that damage their reputation. |
| `regulated_advice` | Specific medical, legal or financial instructions presented as authoritative, where acting on them could cause serious harm. |

## Limits

- English only, and trained on online comments: the classifier is strongest on abusive language and weak on harmful
  requests phrased politely (for example a courteous request for weapon instructions scores low). The reserved labels
  above exist because that gap is real.
- It reacts to words, not intent: quoted abuse, moderation discussions and reclaimed slurs can score high.
- The heuristic `toxicity` detector (ADR-0042) always runs beside it.
