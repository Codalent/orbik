# Workspaces and members

A workspace is one website and everything Orbik knows about it. Its owner can invite other people
as admins, members or read-only members, and each role decides what they may do.

## Creating a workspace

Choose **Create workspace** in the workspace switcher, give the workspace a name and the address
of its website, and choose **Create workspace**. You are its owner. The next step is to crawl the
site (see [Crawling](crawling.md)).

The workspace's settings are under **Settings**: **Workspace** for its name, website and ID,
**People** for who is in it, **Orbik MCP** for connecting your AI, and **AI calls** for every model
call made on your account's behalf, across all your workspaces.

## Changing the name or the website

Admins and the owner can rename the workspace and change its website on **Settings → Workspace**.

- **The same site at a new address** — the same hostname, such as a new start page or `https`
  instead of `http` — keeps everything crawled. The next crawl starts from the new address, unless
  a start address was chosen on the Crawl page.
- **A different site** starts over, and you are asked first. Every page crawled from the old site
  is removed — snapshots, links, page Markdown and crawl history — and a crawl of the new site is
  requested. The Library keeps what people and agents wrote; its copies of the old site's pages are
  replaced as the new pages are crawled. The brand stays as it is.

`www.example.com` and `example.com` are different hostnames, so moving between them counts as a
different site. A website can't be changed while a crawl is running.

## Roles

| | Read-only | Member | Admin | Owner |
| --- | :---: | :---: | :---: | :---: |
| Read everything in the workspace, and ask questions | ✓ | ✓ | ✓ | ✓ |
| Connect an AI that reads the workspace | ✓ | ✓ | ✓ | ✓ |
| Edit the Library, change the brand, crawl, run agents and set them to work | | ✓ | ✓ | ✓ |
| Connect an AI that also writes to the Library | | ✓ | ✓ | ✓ |
| Invite people, change roles, remove people | | | ✓ | ✓ |
| Rename the workspace, change its website, clear its crawl data | | | ✓ | ✓ |
| Delete the workspace | | | | ✓ |

**People** in the settings lists the owner and every member with their role; everyone in the
workspace can see it. Admins and the owner also see the open invites there, and change a member's
role with the picker beside their name.

A read-only person can use Ask; it answers them but changes nothing. The owner is the person who
created the workspace, and nobody can change or remove them.

## Inviting someone

On **Settings → People**, under **Invite someone**, enter their email and a role and choose
**Create invite link**. You get a link to send them. It works once, for that address, for seven
days. If the install sends email, the link is emailed to them as well; either way you can copy it
and send it yourself.

When they open the link:

- signed in with that address, they accept and land in the workspace;
- if the address already has an account, they sign in and then accept;
- if it has none, they choose a password, which creates their account and joins the workspace.

An open invite shows as **Invited** in the list until it is accepted. **Withdraw** takes it back.

## Changing roles, removing and leaving

Admins and the owner change a member's role or **Remove** them on **Settings → People**. A removed
person loses access at once; an invite brings them back. An admin who lowers their own role can no
longer manage members, and only an admin or the owner can give the role back.

Anyone but the owner can leave a workspace with **Leave workspace**, at the foot of **People**.
They lose access at once.

Access ends for a person's AI at the same moment: a token or connected app they made stops reading
a workspace as soon as they leave it or are removed (see
[Connect your AI](../connect-your-ai/README.md)).

## Who started what

What a person starts — a crawl, an agent run, an Ask question — records who started it, and
Activity names them, so in a shared workspace you can see whose work is running. Everything done
in a workspace is counted to its owner, whoever started it.

## Deleting a workspace

Only the owner can delete a workspace, under **Delete this workspace** on **Settings → Workspace**.
Type the workspace's exact name and choose **Delete workspace**. Stop anything running first: a
workspace with a crawl or an agent at work can't be deleted.

Deleting removes every crawled page, the Library, the search index, llms.txt, chats and agent runs;
the brand and the files uploaded to it; and its members and open invites. AI tokens and connected
apps that read only this workspace stop working, and ones that also read other workspaces keep
those. It cannot be undone.

For accounts, sign-in and the install's Admin page, see [Accounts and admin](accounts-and-admin.md).
