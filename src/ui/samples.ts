// Sample bills bundled into the script, so "Try a sample" needs no download.
import aws from '../../samples/aws-cur2.csv?raw';
import azure from '../../samples/azure-cost-details.csv?raw';
import gcp from '../../samples/gcp-console-cost-table.csv?raw';

export const SAMPLES = [
  { id: 'aws', label: 'AWS', file: 'sample-aws-cur2.csv', text: aws },
  { id: 'azure', label: 'Azure', file: 'sample-azure-cost-details.csv', text: azure },
  { id: 'gcp', label: 'Google Cloud', file: 'sample-gcp-cost-table.csv', text: gcp },
];
