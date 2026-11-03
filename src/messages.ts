import { ru } from "./messages-ru.js";

// Every text that rig shows to a person lives in a catalog: stdout and stderr lines, errors, event texts, status lines.
// `en` is the source. `ru` is typed as `Messages`, so a key missing from it is a type error. A parameterized message is
// a function that returns the whole sentence, so no grammar is built in code. Internal diagnostics for developers
// (lock, file and state errors) are plain English at the place that raises them and are not part of the catalog.

export const LANGUAGES = ["en", "ru"] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "en";

export const isLanguage = (value: unknown): value is Language => LANGUAGES.some((language) => language === value);

export const en = {
	languageNames: { en: "English", ru: "Russian" },
	language: {
		line: (name: string): string => `Language: ${name}.`,
		usage: (): string => "Usage: rig language [en|ru] [--json]",
	},
	cli: {
		usageInstall: (): string => "Usage: rig install [--dev]",
		usageUpdateStep: (): string => "Internal command update-step: apply|check <pid> <start time>",
		unknownCommand: (args: string): string => `Unknown command or arguments: ${args}`,
		help: (): string => "Usage: rig install [--dev] | apply | feature [--json] | feature <name> enable|disable | update [--pending] | status [--json] | check | language [en|ru] [--json]",
		rigError: (text: string): string => `rig error: ${text}`,
		checksPassed: (): string => "rig checks passed.",
		featureLine: (name: string, enabled: boolean, platformAllowed: boolean, description: string): string =>
			`${name}: ${enabled ? "enabled" : "disabled"}${platformAllowed ? "" : "; not available on this platform"} - ${description}`,
	},
	status: {
		mode: (mode: string): string => `Mode: ${mode}`,
		unknownVersion: (): string => "unknown",
		hubRestartPending: (pending: boolean): string => `Hub restart pending: ${pending ? "yes" : "no"}`,
		featureLine: (name: string, enabled: boolean, platformAllowed: boolean): string =>
			`Feature ${name}: ${enabled ? "enabled" : "disabled"}${platformAllowed ? "" : " (not available on this platform)"}`,
		lastUpdate: (time: string, text: string): string => `Last update: ${time} - ${text}`,
		errorLine: (type: string, text: string): string => `Error ${type}: ${text}`,
		language: (name: string): string => `Language: ${name}`,
	},
	lock: {
		waiting: (): string => "Another rig command is running, waiting for it to finish.",
	},
	apply: {
		upToDate: (): string => "The rig configuration is already up to date.",
		updatedFiles: (count: number): string => `Files updated: ${count}.`,
		settingsInvalid: (error: string, settingsPath: string): string =>
			`settings.json is invalid: ${error}. Fix the file ${settingsPath}; apply wrote nothing.`,
		blockRestored: (path: string): string => `The rig rules block was restored in ${path}.`,
		changedFileSaved: (path: string): string => `The changed file was saved: ${path}`,
	},
	settings: {
		keptChangedSetting: (id: string, backupPath: string): string => `Rig kept the changed setting "${id}". Copy: ${backupPath}`,
		removedChangedSetting: (id: string, backupPath: string): string => `Rig removed the changed setting "${id}"; the value is saved in the copy: ${backupPath}`,
		removedChangedHook: (id: string, backupPath: string): string => `Rig removed the changed hook "${id}"; the value is saved in the copy: ${backupPath}`,
	},
	cron: {
		absolutePaths: (): string => "The paths to bun and rig must be absolute server paths.",
		pathQuotes: (): string => "The PATH for cron must not contain quotes or line breaks.",
	},
	programs: {
		installPackage: (name: string, command: string): string => `Install the system package ${name}: ${command}`,
		systemPackageMissingNoCommand: (name: string): string => `The system package ${name} was not found; the manifest has no install command.`,
		systemPackageMissing: (name: string, command: string): string => `The system package ${name} was not found. Run: ${command}`,
		programMissing: (name: string): string => `The program ${name} was not found; run rig install.`,
	},
	feature: {
		baseCannotToggle: (): string => "The base feature cannot be switched.",
		unknown: (name: string): string => `Unknown feature ${name}.`,
		platformOnly: (name: string, platforms: string): string => `Feature ${name} is available only on ${platforms}.`,
		enableFirst: (dependency: string, name: string): string => `Enable feature ${dependency} before ${name}.`,
		dependencyUnavailable: (dependency: string, name: string, platform: string): string =>
			`Feature ${dependency} required by ${name} is unavailable on ${platform}.`,
		cannotDisable: (name: string, dependent: string): string => `Cannot disable ${name}; the enabled feature ${dependent} depends on it.`,
		serviceNotStarted: (error: string): string => `The telegram-hub service did not start: ${error}`,
		changed: (name: string, enabled: boolean): string => `Feature ${name} ${enabled ? "enabled" : "disabled"}.`,
		telegramDisabledStopping: (): string => "Feature telegram is disabled; stopping the hub service.",
		revertFailed: (cause: string, error: string): string => `${cause}; reverting the feature failed: ${error}`,
	},
	install: {
		done: (dev: boolean): string => dev ? "rig installation in dev mode is complete." : "rig installation on the server is complete.",
		cloneNotFound: (error: string): string => `Could not find the agent-rig clone: ${error}`,
		notGitClone: (detail: string): string => `The current folder is not a git clone: ${detail}`,
		clonePathUnknown: (): string => "Could not determine the path of the current agent-rig clone.",
		stateReadFailed: (error: string): string => `Could not read state.json: ${error}`,
		crontabMissing: (command: string): string => `The crontab program was not found. Install the package with: ${command}`,
		crontabReadFailed: (detail: string): string => `Could not read the crontab: ${detail}`,
		crontabWriteFailed: (detail: string): string => `Could not write the crontab: ${detail}`,
	},
	check: {
		ruleBlockMissing: (path: string): string => `The built rules block was not found: ${path}`,
		importsMissing: (path: string): string => `The rig imports were not found in ${path}`,
		settingsInvalid: (error: string): string => `settings.json is invalid: ${error}`,
		interpreterMissing: (command: string): string => `The interpreter ${command} was not found.`,
		temporaryCreateFailed: (error: string): string => `Could not create a temporary folder for the check: ${error}`,
		temporaryRemoveFailed: (path: string, error: string): string => `Could not remove the temporary folder ${path}: ${error}`,
		serviceNotRunning: (): string => "The telegram-hub service is not running.",
		hookNotStarted: (feature: string, event: string, error: string): string => `The hook ${feature}/${event} did not start: ${error}`,
		hookExitCode: (feature: string, event: string, exitCode: number, output: string): string =>
			`The hook ${feature}/${event} exited with code ${exitCode}: ${output}`,
		bashMissing: (bash: string): string => `The program ${bash} was not found, so project-tmp.sh cannot be checked.`,
		projectTmpNotStarted: (error: string): string => `Could not run project-tmp.sh: ${error}`,
		projectTmpExitCode: (exitCode: number, output: string): string => `project-tmp.sh exited with code ${exitCode}: ${output}`,
		settingsNotJson: (error: string): string => `settings.json could not be parsed as JSON, the hooks were not checked: ${error}`,
		hookNotRecorded: (feature: string, event: string): string => `The hook ${feature}/${event} is not recorded in settings.json.`,
		readFailed: (path: string, error: string): string => `Could not read ${path}: ${error}`,
	},
	updateCommand: {
		complete: (): string => "The rig update is complete.",
		checkDeferred: (): string => "Another rig command is already running; the check is postponed.",
		stepLockMissing: (): string => "rig update-step runs only from rig update: the rig lock was not found.",
		stepLockOtherProcess: (): string => "rig update-step runs only from rig update: the rig lock belongs to another process.",
		stepParentExited: (): string => "rig update-step runs only from rig update: the parent process has already exited.",
		newCodeNotStarted: (step: string, error: string): string => `Could not start the new rig code (${step}): ${error}`,
		newCodeExitCode: (step: string, exitCode: number): string => `The new rig code (${step}) exited with code ${exitCode}.`,
		pendingNotJson: (): string => "The pending hub restart record is damaged: it is not JSON.",
		pendingBadShape: (): string => "The pending hub restart record is damaged: wrong shape.",
	},
	update: {
		repositoryTitles: { rig: "agent-rig", hub: "hub" },
		devUnavailable: (): string => "Update is not available in dev mode.",
		pendingDevUnavailable: (): string => "The pending restart check is not available in dev mode.",
		fetchMainFailed: (repository: string): string => `Could not fetch main of the ${repository} repository.`,
		readVersionsFailed: (): string => "Could not read the clone versions.",
		workingAgain: (): string => "Update works again: the clones match main.",
		branchCheckFailed: (repository: string): string => `Could not check the branch of the ${repository} clone.`,
		skippedNotOnMain: (repository: string): string => `Update skipped: the ${repository} clone is not on branch main.`,
		skippedLocalCommits: (repository: string): string => `Update skipped: the ${repository} clone has local commits that origin/main lacks.`,
		localChangesCheckFailed: (repository: string): string => `Could not check local changes in ${repository}.`,
		skippedLocalChanges: (): string => "Update skipped: one of the clones has local changes.",
		hubStateCheckFailed: (): string => "Could not check the hub restart state.",
		hubNotReady: (minutes: number): string => `The hub did not report ready within ${minutes} minutes after the restart began.`,
		hubWaitingLong: (): string => "The hub restart has been waiting for a safe moment for more than a day.",
		noActiveTransaction: (): string => "There is no active update transaction.",
		fastForwardFailed: (repository: string, error: string): string => `Could not fast-forward ${repository}: ${error}`,
		applyFailed: (error: string): string => `rig apply failed: ${error}`,
		checkFailed: (error: string): string => `rig check failed: ${error}`,
		featureListFailed: (): string => "Could not load the feature list.",
		newFeature: (name: string): string => `The new feature "${name}" is disabled. Enable it: rig feature ${name} enable`,
		updated: (changes: string): string => `Updated: ${changes}.`,
		hubWillRestart: (): string => "The hub must restart after the current sessions end.",
		noCompletionData: (): string => "The transaction has no completion data.",
		noActiveRollback: (): string => "There is no active rollback.",
		resetKeepFailed: (detail: string): string => `Could not run git reset --keep: ${detail}`,
		rollbackApplyFailed: (error: string): string => `The repeated rig apply during the rollback failed: ${error}`,
		rollbackRestartFailed: (error: string): string => `Could not restart the hub service after the rollback: ${error}`,
		notRollingBack: (): string => "The transaction is not in the rollback state.",
		failureWithRestored: (failure: string): string => `${failure} The clones were returned to the confirmed versions.`,
		failureWithDetail: (failure: string, detail: string): string => `${failure} ${detail}`,
		restored: (): string => "The clones were returned to the confirmed versions.",
	},
	runtime: {
		platformUnsupported: (platform: string): string => `The platform ${platform} is not supported.`,
		processStartUnknown: (error: string): string => `Could not determine the process start time for the rig lock: ${error}`,
		processNotFound: (): string => "Could not determine the process start time for the rig lock: the process was not found.",
		taskRestartLabel: (): string => "Restarting the telegram-hub task",
		serviceUnsupported: (platform: string): string => `Service control is not supported on ${platform}.`,
		serviceInactive: (exitCode: number, output: string): string =>
			`systemctl --user is-active telegram-hub.service (code ${exitCode}): ${output.length > 0 ? output : "no output"}`,
		serviceCheckUnsupported: (platform: string): string => `The service check is not supported on ${platform}.`,
		codexInstallLabel: (): string => "Could not install Codex through Bun",
		opencodeInstallLabel: (): string => "Could not install OpenCode through npm",
		noRootInstall: (name: string): string => `No install without root is defined for the program ${name}.`,
		rtkChecksumMismatch: (assetName: string): string => `The rtk release checksum did not match for ${assetName}.`,
		rtkExtractLabel: (): string => "Could not unpack the rtk release",
		rtkBinaryMissing: (targetName: string, error: string): string => `The rtk release archive has no ${targetName}: ${error}`,
		rtkInstallFailed: (error: string): string => `Could not install rtk: ${error}`,
		rtkUnsupported: (platform: string): string => `Installing rtk is not supported on ${platform}.`,
		githubStatus: (status: number): string => `GitHub did not return the latest rtk release: HTTP ${status}.`,
		githubBadRelease: (): string => "GitHub returned invalid data for the latest rtk release.",
		githubNoAssetList: (): string => "The GitHub response has no list of rtk release files.",
		rtkAssetsMissing: (target: string): string => `The rtk release has no archive ${target} or checksums.txt.`,
		checksumMissing: (target: string): string => `checksums.txt has no checksum for ${target}.`,
		rtkFetchFailed: (error: string): string => `Could not get the rtk release: ${error}`,
	},
};

export type Messages = typeof en;

export const messagesFor = (language: Language): Messages => language === "ru" ? ru : en;
