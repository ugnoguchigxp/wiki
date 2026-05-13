#!/usr/bin/env node

/**
 * 🛡️ Security Scan Script (Full Shai-Hulud & Mini Shai-Hulud Detector)
 *
 * [概要]
 * オリジナル版 "Shai-Hulud" ワームおよび "Mini Shai-Hulud" キャンペーンを包括的に検知します。
 * 名前だけでなく「通信先」「署名」「動作」から多角的に分析します。
 *
 * [使い方]
 * 1. node scripts/security-scan.mjs (カレントディレクトリ)
 * 2. node scripts/security-scan.mjs /path/to/scan (特定ディレクトリ)
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, execSync } from 'node:child_process';

const TARGET_DIR = resolve(process.argv[2] || process.cwd());

const IOC_FILES = [
  '.claude/router_runtime.js', '.claude/setup.mjs', '.claude/settings.json',
  '.vscode/setup.mjs', '.vscode/tasks.json', 'setup_bun.js', 'bun_environment.js',
  'cloud.json', 'gh-token-monitor', '.github/workflows/shai-hulud-workflow.yml',
  '.github/workflows/discussion.yaml'
];

const IOC_DOMAINS = [
  'filev2.getsession.org', 'git-tanstack.com', 'api.masscan.cloud', 'zero.masscan.cloud',
  'oshizushi.org', 'shai-hulud.io', 'shai-hulud.net', 'mini-shai.net', 'arrakis.tech',
  'sandworm.io', 'spice-must-flow.net'
];

const IOC_SIGNATURES = [
  'A Mini Shai-Hulud has Appeared', 'Sha1-Hulud: The Second Coming',
  'Shai-Hulud: Here We Go Again', 'Bless the Maker and His water',
  'The sleeper has awakened', 'The spice must flow'
];

async function runCommand(cmd, args) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    proc.stdout.on('data', (data) => {
      const str = data.toString();
      output += str;
      process.stdout.write(str); // リアルタイムに表示
    });
    proc.on('close', () => resolve(output.trim()));
  });
}

async function scan() {
  console.log(`🚀 Starting FULL Shai-Hulud Security Scan in: ${TARGET_DIR}`);
  console.log('⚠️  Deep scanning mode: including node_modules and hidden files...');
  let issues = 0;

  // 1. File IoC Check
  console.log('\n--- 📁 File IoC Check (Global) ---');
  const findArgs = IOC_FILES.map(f => `-name "${f}"`).flatMap((f, i) => i === 0 ? [f] : ['-o', f]);
  const fileHits = await runCommand('find', [TARGET_DIR, '(', ...findArgs, ')', '-not', '-path', '*/node_modules/*']);
  if (fileHits) issues++;
  else console.log('✅ No suspicious campaign files found.');

  // 2. Deep Content Scan
  console.log('\n--- 🔍 Deep Content Signature Check ---');
  const query = [...IOC_DOMAINS, ...IOC_SIGNATURES].join('|');
  const contentHits = await runCommand('grep', ['-rE', query, '--exclude=security-scan.mjs', TARGET_DIR]);
  if (contentHits) issues++;
  else console.log('✅ No malicious domains or campaign signatures found.');

  // 3. Process Check
  console.log('\n--- ⚙️ Process Check ---');
  try {
    const ps = execSync('ps aux | grep -E "gh-token-monitor|sandworm|muaddib" | grep -v grep || true', { encoding: 'utf8' });
    if (ps.trim()) {
      console.error(`❌ CRITICAL: Malicious process detected!\n${ps.trim()}`);
      issues++;
    } else {
      console.log('✅ No malicious processes detected.');
    }
  } catch (err) {}

  console.log('\n--------------------------------------');
  if (issues > 0) {
    console.error(`⚠️  Full scan found ${issues} issue(s). ACTION REQUIRED!`);
    process.exit(1);
  } else {
    console.log('🎉 Full scan completed. Environment appears clean.');
  }
}

scan().catch(err => {
  console.error('Fatal error during scan:', err);
  process.exit(1);
});
