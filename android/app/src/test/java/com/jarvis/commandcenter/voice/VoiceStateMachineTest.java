package com.jarvis.commandcenter.voice;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class VoiceStateMachineTest {
    @Test
    public void waitingPermissionCarriesExactTaskAndClearsOnTransition() {
        VoiceStateMachine machine = new VoiceStateMachine();
        machine.transition(VoiceStateMachine.State.STARTING);
        machine.waiting(VoiceStateMachine.WaitingReason.PERMISSION, "task-42");

        VoiceStateMachine.Snapshot waiting = machine.snapshot();
        assertEquals(VoiceStateMachine.State.WAITING_USER, waiting.state);
        assertEquals(VoiceStateMachine.WaitingReason.PERMISSION, waiting.waitingReason);
        assertEquals("task-42", waiting.taskId);

        machine.transition(VoiceStateMachine.State.WAITING_WAKE_WORD);
        VoiceStateMachine.Snapshot ready = machine.snapshot();
        assertEquals(VoiceStateMachine.WaitingReason.NONE, ready.waitingReason);
        assertNull(ready.taskId);
    }

    @Test
    public void errorIsIsolatedAndClearedByHealthyTransition() {
        VoiceStateMachine machine = new VoiceStateMachine();
        machine.error("WAKE_WORD_MODEL_NOT_CONFIGURED");
        assertEquals(VoiceStateMachine.State.ERROR, machine.snapshot().state);
        assertEquals("WAKE_WORD_MODEL_NOT_CONFIGURED", machine.snapshot().errorCode);

        machine.transition(VoiceStateMachine.State.PAUSED);
        assertNull(machine.snapshot().errorCode);
    }
}
