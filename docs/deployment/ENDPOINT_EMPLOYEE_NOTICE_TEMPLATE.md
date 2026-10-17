# Employee notice template: discovery of AI tools on work devices

ADR-0195 decision 20. This is a starting point for the notice you give employees before you enable either endpoint
discovery option (the osquery query pack with result or inventory imports, or the RegulAIt endpoint agent).

> **This template is not legal advice, and RegulAIt makes no compliance claim about endpoint discovery.**
> Employee-monitoring and privacy law, including data-protection rules such as the GDPR and works-council or
> employee-representative consultation duties, differs by country and sometimes by region or sector. Have your legal
> team or outside counsel review and adapt this notice, and complete any consultation, data-protection impact
> assessment or registration your jurisdiction requires, before you enable endpoint discovery.

Replace everything in `[square brackets]`. Delete any line that does not apply to your deployment.

---

**Subject: How [Company] checks work devices for AI tools**

[Company] uses RegulAIt to keep track of which artificial intelligence (AI) tools are in use on work devices, so that
we can offer approved tools and manage the risks of unapproved ones, such as company data leaving through a personal
AI account.

**What we check.** Once a day, [our device-management software / the RegulAIt agent] records whether these are present
on [company-owned devices / devices enrolled in [MDM name]]:

- installed AI desktop applications;
- AI extensions in code editors and web browsers;
- AI command-line tools and local AI model software, and the network ports that software listens on;
- the **names** of AI-related settings (for example, that a setting named after an AI service's key exists, never what it holds), and whether AI
  assistant configuration files exist.

**What we do not collect.** We do not collect the contents of files, the value of any setting or key, what you type,
screenshots, your clipboard, your browsing history, or anything you write to or receive from an AI tool.

**How you are identified.** Reports identify you by a coded reference, not by your name. [Named roles, for example
the security team] can see the name behind a reference only when [a stated reason, for example investigating a
specific incident], and each time they do it is recorded.

**How long we keep it.** Device reports are deleted after [90] days[, unless they are part of an open investigation].

**Why.** [State your purpose and, where your law requires it, your legal basis, for example our legitimate interest in
protecting company and customer data.]

**Your rights.** [Describe the access, correction, objection and complaint rights that apply to you, and who to contact:
name or role, email.]

**Questions.** Contact [team, email].

[Date of notice] · [Version]

---

## Before you send it

- Check that the list under "What we check" matches what you actually enabled. If you import only an MDM or EDR
  software inventory, remove the lines your inventory does not contain.
- Make sure the retention period matches your RegulAIt setting (90 days by default; a longer period is an audited
  relaxation).
- Keep a record of when and how the notice was given.
