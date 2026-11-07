/**
 * Appointly Text-Only CLI Chat REPL & Flow Simulator
 * Allows live conversation with the Hinglish Voice Agent state machine.
 *
 * Usage:
 *   Interactive REPL: npm run chat:cli
 *   Scripted Flow:    npx tsx scripts/cli-chat.ts --flow=booking
 *                     npx tsx scripts/cli-chat.ts --flow=emergency
 *                     npx tsx scripts/cli-chat.ts --flow=reschedule
 *                     npx tsx scripts/cli-chat.ts --flow=cancel
 */

import readline from 'readline';
import {
  createSession,
  processConversationTurn,
  ConversationSession,
} from '../apps/api/src/agent/orchestrator.js';
import { getDatabaseClient } from '../apps/api/src/db/index.js';
import { getBookingCoreService } from '../apps/api/src/services/booking-service.js';

const SCRIPTED_FLOWS: Record<string, string[]> = {
  booking: [
    'Namaste',
    'Mujhe Dr. Sharma se milna hai bukhar ke liye',
    'Aane wale somwar shaam ko 5 baje ka time chalega',
    'Mera naam Rajesh Verma hai',
    'Haan, appointment confirm kar do',
  ],
  emergency: [
    'Namaste',
    'Doctor jaldi madad karo, mere papa ko severe chest pain ho raha hai aur saans nahi aa rahi',
  ],
  reschedule: [
    'Namaste',
    'Mujhe apni appointment reschedule karni hai',
    'Somwar 11:00 baje kar do please',
  ],
  cancel: ['Namaste', 'Mujhe appointment cancel karni hai', 'Haan, cancel kar dijiye'],
};

async function runScriptedFlow(flowName: string): Promise<void> {
  const utterances = SCRIPTED_FLOWS[flowName];
  if (!utterances) {
    console.error(`Unknown flow: "${flowName}". Available: booking, emergency, reschedule, cancel`);
    process.exit(1);
  }

  console.log(`\n======================================================`);
  console.log(`  APPOINTLY CLI CHAT — SCRIPTED FLOW: ${flowName.toUpperCase()}`);
  console.log(`======================================================\n`);

  const session = createSession('9876543210');

  // For reschedule and cancel flows, prepare an active appointment record
  if (flowName === 'reschedule' || flowName === 'cancel') {
    const bookingService = getBookingCoreService();
    const setupRes = await bookingService.bookAppointment({
      doctorId: 'dr_sharma',
      date: '2026-11-16',
      startTime: '10:00',
      patientName: 'Test Patient',
      patientPhone: '9876543210',
      idempotencyKey: `flow_setup_${Date.now()}_${flowName}`,
    });
    if (setupRes.appointment) {
      session.appointmentId = setupRes.appointment.id;
      session.doctorName = setupRes.appointment.doctorName || 'Dr. Rajesh Sharma';
      session.doctorId = setupRes.appointment.doctorId;
      console.log(
        `[Flow Setup] Prepared active test appointment: ${session.appointmentId} (${setupRes.appointment.appointmentDate} ${setupRes.appointment.startTime})\n`
      );
    }
  }

  for (const input of utterances) {
    console.log(`\n🗣️ Patient: "${input}"`);
    const response = await processConversationTurn(session, input);
    console.log(`🤖 Agent [${response.state}]:\n   "${response.replyText}"`);

    if (response.confirmedBooking) {
      console.log(`\n📋 Confirmed DB Read-Back:`);
      console.log(`   - Doctor:   ${response.confirmedBooking.doctorName}`);
      console.log(`   - Date:     ${response.confirmedBooking.date}`);
      console.log(`   - Time:     ${response.confirmedBooking.startTime}`);
      console.log(`   - Duration: ${response.confirmedBooking.durationMinutes} mins`);
      console.log(`   - Appt ID:  ${response.confirmedBooking.appointmentId}`);
    }

    if (response.isTerminal) {
      console.log(`\n🏁 Call completed. Terminal State: ${response.state}`);
      break;
    }
  }

  console.log(`\nFlow "${flowName}" executed successfully.\n`);
}

async function runInteractiveRepl(): Promise<void> {
  console.log(`\n======================================================`);
  console.log(`  APPOINTLY LIVE CLI CHAT (Hinglish Voice Agent Brain)`);
  console.log(`  Type in Hindi, English, or Hinglish (e.g. "Mujhe kal Dr Sharma se milna hai")`);
  console.log(`  Type "exit" or "quit" to end call.`);
  console.log(`======================================================\n`);

  const session = createSession('9876543210');

  // Initial Greeting Turn
  const greeting = await processConversationTurn(session, 'Namaste');
  console.log(`🤖 Appointly [${greeting.state}]:\n   "${greeting.replyText}"\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const promptUser = () => {
    rl.question('🗣️  You > ', async (userInput) => {
      const trimmed = userInput.trim();
      if (!trimmed || trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
        console.log('\nCall ended. Namaste!\n');
        rl.close();
        process.exit(0);
      }

      try {
        const turn = await processConversationTurn(session, trimmed);
        console.log(`\n🤖 Appointly [${turn.state}]:\n   "${turn.replyText}"\n`);

        if (turn.confirmedBooking) {
          console.log(`📋 DB Confirmed Record:`);
          console.log(`   Doctor:   ${turn.confirmedBooking.doctorName}`);
          console.log(`   Date:     ${turn.confirmedBooking.date}`);
          console.log(`   Time:     ${turn.confirmedBooking.startTime}`);
          console.log(`   Duration: ${turn.confirmedBooking.durationMinutes} min\n`);
        }

        if (turn.isTerminal) {
          console.log(`[Call Completed - State: ${turn.state}]\n`);
          rl.close();
          process.exit(0);
        } else {
          promptUser();
        }
      } catch (err) {
        console.error('Error processing turn:', err);
        promptUser();
      }
    });
  };

  promptUser();
}

async function main() {
  const args = process.argv.slice(2);
  const flowArg = args.find((a) => a.startsWith('--flow='));

  if (flowArg) {
    const flowName = flowArg.split('=')[1];
    await runScriptedFlow(flowName);
    process.exit(0);
  } else if (!process.stdin.isTTY) {
    // Non-interactive fallback: run booking flow as smoke test
    await runScriptedFlow('booking');
    process.exit(0);
  } else {
    await runInteractiveRepl();
  }
}

main().catch((err) => {
  console.error('Fatal CLI Chat error:', err);
  process.exit(1);
});
