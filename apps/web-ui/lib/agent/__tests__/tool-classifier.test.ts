import { describe, it, expect } from 'vitest';
import { classifyTool } from '@/lib/agent/tool-classifier';

describe('classifyTool (shared location)', () => {
    it('classifies read-only allowlisted tools as safe', () => {
        expect(classifyTool('get_aws_credentials').isMutative).toBe(false);
        expect(classifyTool('list_aws_accounts').isMutative).toBe(false);
    });

    it('classifies read-only aws CLI commands via execute_command as safe', () => {
        const r = classifyTool('execute_command', { command: 'aws ec2 describe-instances --output json' });
        expect(r.isMutative).toBe(false);
    });

    it('classifies mutative aws CLI commands via execute_command as mutative', () => {
        const r = classifyTool('execute_command', { command: 'aws ec2 terminate-instances --instance-ids i-0abc' });
        expect(r.isMutative).toBe(true);
    });

    it('classifies rm -rf as mutative', () => {
        expect(classifyTool('execute_command', { command: 'rm -rf /tmp/x' }).isMutative).toBe(true);
    });

    it('classifies name-pattern mutations (write_file) as mutative', () => {
        expect(classifyTool('write_file', { file_path: 'a', content: 'b' }).isMutative).toBe(true);
    });
});
