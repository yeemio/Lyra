"""PR2 protocol regressions: synthetic HTTP only, no requests/AKShare installation."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('emrisk_bridge', Path(__file__).with_name('bridge.py'))
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)
CODE = '600519'


def page(rows, count=None, pages=1):
    return {'success': True, 'result': {'pages': pages, 'count': len(rows) if count is None else count, 'data': rows}}


def rows(n):
    return [{'SECURITY_CODE': CODE, 'TRADE_DATE': f'2026-10-{i % 28 + 1:02d} 00:00:00',
             'PLEDGE_RATIO': i, 'END_DATE': '2026-06-30 00:00:00', 'HOLD_NOTICE_DATE': '2026-08-01',
             'HOLDER_NUM': str(100 + i)} for i in range(n)]


class ProtocolTests(unittest.TestCase):
    def call(self, payloads, command='pledge'):
        calls = []
        def get(url, params, timeout):
            calls.append(params)
            item = payloads[len(calls) - 1]
            if isinstance(item, Exception):
                raise item
            status, body = item if isinstance(item, tuple) else (200, json.dumps(item, ensure_ascii=False))
            return types.SimpleNamespace(status_code=status, text=body)
        with patch.dict(sys.modules, {'requests': types.SimpleNamespace(get=get)}):
            return bridge.run(command, CODE), calls

    def test_source_error_is_not_empty(self):
        for cmd in ('pledge', 'gdhs'):
            with self.subTest(command=cmd), self.assertRaises(bridge.BridgeError) as caught:
                self.call([{'success': False, 'result': None, 'message': 'source unavailable'}], cmd)
            self.assertEqual(caught.exception.code, 'EMRISK_SOURCE_ERROR')
            self.assertIn('source unavailable', caught.exception.meta['rawPages'][0]['body'])
            self.assertFalse(caught.exception.meta['complete'])

    def test_structural_errors(self):
        bad = [None, [], {'result': None}, {'success': True, 'result': None},
               {'success': True, 'result': {'data': [], 'pages': 0}},
               {'success': True, 'result': {'data': None, 'pages': 0, 'count': 0}},
               page([], 1, 1), page([], 0, True), page(rows(1), 1, 2), page([None])]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(bridge.BridgeError):
                self.call([value])

    def test_confirmed_empty(self):
        for command in ('pledge', 'gdhs'):
            for pages in (0, 1):
                with self.subTest(command=command, pages=pages):
                    result, calls = self.call([page([], pages=pages)], command)
                    self.assertEqual(result['rows'], [])
                    self.assertTrue(result['meta']['complete'])
                    self.assertTrue(result['meta']['emptySource'])
                    self.assertEqual(len(calls), 1)

    def test_later_page_failure_keeps_first_page(self):
        for second in [{'success': False, 'result': None}, (503, 'unavailable'), (200, 'not json'), TypeError('NoneType')]:
            with self.subTest(second=second), self.assertRaises(bridge.BridgeError) as caught:
                self.call([page(rows(500), 501, 2), second])
            evidence = caught.exception.meta
            self.assertEqual(evidence['receivedRows'], 500)
            self.assertEqual(evidence['failedPage'], 2)
            self.assertEqual(len(evidence['rawPages']), 2)
            self.assertFalse(evidence['complete'])

    def test_pagination_drift_and_duplicates(self):
        first = page(rows(500), 501, 2)
        for second in [page([], 501, 2), page(rows(1), 502, 2), page(rows(1), 501, 1), page(rows(1), 501, 2)]:
            with self.subTest(second=second), self.assertRaises(bridge.BridgeError) as caught:
                self.call([first, second])
            self.assertEqual(caught.exception.code, 'EMRISK_PAGINATION_INVALID')

    def test_complete_pages_and_gdhs_mapping(self):
        original = rows(501)
        for command in ('pledge', 'gdhs'):
            result, calls = self.call([page(original[:500], 501, 2), page(original[500:], 501, 2)], command)
            self.assertEqual(len(result['rows']), 501)
            self.assertEqual([c['pageNumber'] for c in calls], ['1', '2'])
            self.assertEqual(calls[0]['pageSize'], '500')
            self.assertTrue(result['meta']['complete'])
            if command == 'gdhs':
                self.assertEqual(result['rows'][0]['股东户数-本次'], 100)
                self.assertEqual(result['rows'][0]['股东户数统计截止日'], '2026-06-30')
                self.assertEqual(result['rows'][0]['股东户数公告日期'], '2026-08-01')
            else:
                self.assertEqual(result['rows'][0]['TRADE_DATE_ISO'], '2026-10-01')

    def test_wrong_subject_and_transport_errors(self):
        with self.assertRaises(bridge.BridgeError):
            self.call([page([{'SECURITY_CODE': '000001'}])])
        with self.assertRaises(bridge.BridgeError) as caught:
            self.call([TypeError('NoneType')], 'gdhs')
        self.assertEqual(caught.exception.code, bridge.QUERY_ERROR)

    def test_cli_error_exit_and_evidence(self):
        script = '''import importlib.util,json,sys,types
s=importlib.util.spec_from_file_location('b',sys.argv[1]); b=importlib.util.module_from_spec(s);s.loader.exec_module(b)
sys.modules['requests']=types.SimpleNamespace(get=lambda *a,**kw:types.SimpleNamespace(status_code=200,text=json.dumps({'success':False,'result':None})))
sys.exit(b.main(['pledge','600519']))'''
        result = subprocess.run([sys.executable, '-c', script, str(Path(__file__).with_name('bridge.py'))], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        payload = json.loads(result.stdout)
        self.assertFalse(payload['ok'])
        self.assertEqual(payload['meta']['failedPage'], 1)
        self.assertEqual(len(payload['meta']['rawPages']), 1)


if __name__ == '__main__':
    unittest.main()
