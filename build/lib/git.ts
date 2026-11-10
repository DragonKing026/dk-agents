/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from 'path';
import fs from 'fs';

/**
 * Returns the sha1 commit version of a repository or undefined in case of failure.
 */
/**
 * Resolves the git directory of `repo`. In a linked worktree `.git` is a file
 * pointing at the worktree's private git directory (`gitdir: <path>`), whose
 * `commondir` names the shared one that holds the refs.
 */
function getGitDirs(repo: string): { gitDir: string; commonDir: string } {
	let gitDir = path.join(repo, '.git');
	try {
		if (fs.statSync(gitDir).isFile()) {
			const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'));
			if (match) {
				gitDir = path.resolve(repo, match[1].trim());
			}
		}
	} catch (e) {
		// noop
	}
	let commonDir = gitDir;
	try {
		commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
	} catch (e) {
		// noop
	}
	return { gitDir, commonDir };
}

export function getVersion(repo: string): string | undefined {
	const { gitDir, commonDir: git } = getGitDirs(repo);
	const headPath = path.join(gitDir, 'HEAD');
	let head: string;

	try {
		head = fs.readFileSync(headPath, 'utf8').trim();
	} catch (e) {
		return undefined;
	}

	if (/^[0-9a-f]{40}$/i.test(head)) {
		return head;
	}

	const refMatch = /^ref: (.*)$/.exec(head);

	if (!refMatch) {
		return undefined;
	}

	const ref = refMatch[1];
	const refPath = path.join(git, ref);

	try {
		return fs.readFileSync(refPath, 'utf8').trim();
	} catch (e) {
		// noop
	}

	const packedRefsPath = path.join(git, 'packed-refs');
	let refsRaw: string;

	try {
		refsRaw = fs.readFileSync(packedRefsPath, 'utf8').trim();
	} catch (e) {
		return undefined;
	}

	const refsRegex = /^([0-9a-f]{40})\s+(.+)$/gm;
	let refsMatch: RegExpExecArray | null;
	const refs: { [ref: string]: string } = {};

	while (refsMatch = refsRegex.exec(refsRaw)) {
		refs[refsMatch[2]] = refsMatch[1];
	}

	return refs[ref];
}
