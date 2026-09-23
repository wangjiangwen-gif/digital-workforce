import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('validator', Path(__file__).with_name('validate.py'))
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


class ValidatorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.context = dict(run_id='run-1', project_id='project-1', period={'start': '2026-09-01T00:00:00+08:00', 'end': '2026-09-08T00:00:00+08:00'}, input_sha256='a' * 64)
        self.put('events.json', dict(**self.context, events=[{'event_id': 'event-1', 'source_urls': ['https://example.com/source']}]))
        self.put('quality.json', {'input_sha256': 'a' * 64, 'period_start': self.context['period']['start'], 'period_end': self.context['period']['end'], 'valid_count': 1})
        self.put('review-items.json', dict(**self.context, items=[]))
        body = '\n'.join(validator.SECTIONS) + '\nevent-1 https://example.com/source'
        (self.root / 'report.md').write_text(body)
        (self.root / 'report.html').write_text('<html><body>' + body + '</body></html>')
        self.manifest = dict(schema_version=1, **self.context, delivery_status='draft', files={name: hashlib.sha256((self.root / name).read_bytes()).hexdigest() for name in validator.FILES})
        self.put('output-manifest.json', self.manifest)

    def tearDown(self):
        self.directory.cleanup()

    def put(self, name, value):
        (self.root / name).write_text(json.dumps(value))

    def refresh(self, name):
        self.manifest['files'][name] = hashlib.sha256((self.root / name).read_bytes()).hexdigest()
        self.put('output-manifest.json', self.manifest)

    def errors(self):
        return [e['code'] for e in validator.validate(self.root)['errors']]

    def test_valid_draft(self):
        self.assertEqual(self.errors(), [])
        self.assertEqual(validator.validate(self.root)['status'], 'draft_validated')

    def test_cross_run(self):
        events = json.loads((self.root / 'events.json').read_text())
        events['run_id'] = 'other'
        self.put('events.json', events)
        self.refresh('events.json')
        self.assertIn('CONTEXT_MISMATCH', self.errors())

    def test_missing_source(self):
        (self.root / 'report.md').write_text('\n'.join(validator.SECTIONS) + '\nevent-1')
        self.refresh('report.md')
        self.assertIn('MISSING_CITATION', self.errors())

    def test_changed_file(self):
        (self.root / 'report.md').write_text('changed')
        self.assertIn('HASH_MISMATCH', self.errors())

    def test_unsafe_html(self):
        with (self.root / 'report.html').open('a') as f:
            f.write('<img src="https://example.com/x" onerror="alert(1)">')
        self.refresh('report.html')
        self.assertIn('UNSAFE_HTML', self.errors())

    def test_self_reported_publication_rejected(self):
        self.manifest['delivery_status'] = 'published'
        self.put('output-manifest.json', self.manifest)
        self.assertIn('UNVERIFIED_DELIVERY', self.errors())

    def test_symlink_rejected(self):
        (self.root / 'report.md').unlink()
        (self.root / 'report.md').symlink_to('/etc/hosts')
        self.assertIn('INVALID_FILE', self.errors())

    def test_malformed_json(self):
        (self.root / 'events.json').write_text('[]')
        self.refresh('events.json')
        self.assertIn('INVALID_SCHEMA', self.errors())

    def test_pending_review(self):
        self.put('review-items.json', dict(**self.context, items=[{'id': 'r1', 'status': 'pending'}]))
        self.refresh('review-items.json')
        self.assertIn('PENDING_REVIEW', self.errors())

    def setup_v2(self):
        self.manifest.update(schema_version=2, rules_version='weekly-v2.1', stage='report')
        self.manifest['files'].pop('report.html')
        (self.root/'report.html').unlink()
        (self.root/'report.md').write_text('\n'.join(validator.SECTIONS_V2)+'\nevent-1 https://example.com/source')
        self.refresh('report.md')
        approvals={}
        for gate,artifact in [('HC1','sample-annotations.json'),('HC2','full-annotations.json')]:
            self.put(artifact, {'rows':[{'row_id':'fixture-1'}]});self.refresh(artifact)
            approvals[gate]=dict(run_id='run-1',project_id='project-1',input_sha256='a'*64,rules_version='weekly-v2.1',gate=gate,decision='approved',actor_id='user',message_id='om-confirm-'+gate,approved_at='2026-09-23T12:00:00+08:00',artifact_sha256=self.manifest['files'][artifact])
        self.put('approvals.json',approvals);self.refresh('approvals.json')
        for name in ['sample-health.json','full-health.json']:
            self.put(name,dict(run_id='run-1',rules_version='weekly-v2.1',status='ready_for_review'));self.refresh(name)
        self.put('cost.json',dict(complete=True));self.refresh('cost.json')

    def test_v2_report_does_not_require_html_before_hc3(self):
        self.setup_v2();self.assertEqual(self.errors(),[])

    def test_v2_rejects_changed_approved_batch(self):
        self.setup_v2();self.put('full-annotations.json',{'changed':True});self.refresh('full-annotations.json')
        self.assertIn('APPROVAL_REQUIRED',self.errors())

    def test_v2_webpage_requires_hc3(self):
        self.setup_v2();self.manifest['stage']='webpage';self.put('output-manifest.json',self.manifest)
        self.assertIn('APPROVAL_REQUIRED',self.errors())


if __name__ == '__main__':
    unittest.main()
