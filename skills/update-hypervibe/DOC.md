# /update-hypervibe

Updates Hypervibe to the latest published version, without leaving your conversation.

## When to use it

{{callout:info|It depends on how you installed Hypervibe}}
If you installed the plugin **with a command** (`/plugin marketplace add flavien-ia/hypervibe-harness`), Claude Code already keeps it up to date on its own. This command will tell you so and hand you the native command rather than doing anything behind its back.
{{/callout}}

- You installed Hypervibe by **uploading the zip** into Claude Desktop, and you want to know whether a newer version is out
- A new version has been announced and you want it without redoing the manual installation
- You simply want to check which version you are running

## How it works

1. **It works out how you installed the plugin.** Claude Code keeps a registry of where each plugin comes from. Hypervibe reads it rather than guessing.

2. **It compares versions.** Your local version against the one published in the public repository. If they match, it stops there and tells you.

3. **It downloads the new version** from hypervibe.fr. No account, no key: the plugin is open source (Apache 2.0).

4. **It checks the archive before touching anything.** The new version is unpacked to a side folder and inspected: is it a genuine complete plugin, is the version the expected one, is nothing trying to write outside its own folder. Your working installation is not touched until those checks pass.

5. **It swaps the folders and keeps a backup.** The old version is set aside as `hypervibe-backup-<version>`. If any step fails, it is put straight back: you never end up without a plugin.

6. **It brings your shared clock in step.** If your Cloudflare account runs Hypervibe's shared clock (the `hypervibe-jobs` worker behind database backups, quota alerts and scheduled tasks), it checks that the clock runs the code of the version you now have, and redeploys it if not. A clock left behind keeps its old defects, even under an up-to-date plugin. This check also runs when you are already up to date.

7. **It offers to close the admin space of your existing projects.** Until 3.4.17, a page of the admin space that `/add-auth` creates could let its content be read by someone who asked for it without being signed in. The command looks for the projects of your computer that still have this defect, lists them, and repairs the ones you choose: each admin page then checks for itself that it is you, and the project's rules stop teaching Claude the old way. Nothing is written before your answer. The repair protects your live site only once it is online again: the command offers to save the change and to publish it, and the publication remains your yes. A project kept in several folders (working copies of one repository, each on its branch) is listed once, the folder of the branch your site goes online from first. Its other folders are never repaired by this step: when they still have the old pages, the command says so in one line, with whether they hold work in progress, and you can bring them up to date or remove them. In the same pass, and with the same yes, it also repairs the sign-in and notification links that still check the address they bring back to with a filter that a link to another site gets through. A line you changed by hand is left as it is, and named: `/security` in that project fixes it. This also runs when you are already up to date.

8. **It asks you to restart Claude Code**, which is what actually loads the new version.

## What you get

- The plugin updated in place, at the same path
- The previous version kept as a backup next to it, until you decide to delete it
- The local plugin catalogue kept in step with the new version number
- Your shared clock running the same version as the plugin, if you have one
- The admin space of the projects you chose closed, on your live site once they are published again

## Good to know

- **The backup is not deleted automatically.** Restart, check that everything works, then ask to have it removed.
- **A failed update costs you nothing**: the previous version is restored on its own, and the command tells you what went wrong.
- **Nothing is sent to Hypervibe.** The check reads a public file, the download is anonymous. The only upload is your shared clock's code, to your own Cloudflare account, and only when it was behind.
