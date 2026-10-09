import java.time.Clock;
import java.util.Objects;

public final class LocalSnowflake {
    public interface LeaseGuard {
        void ensureUsable();
    }
    private static final long WORKER_MAX = (1L << 10) - 1;
    private static final long SEQUENCE_MAX = (1L << 12) - 1;
    private static final long TIME_MAX = (1L << 41) - 1;
    private final Clock clock;
    private final LeaseGuard lease;
    private final long worker;
    private final long epochMillis;
    private long lastMillis = -1;
    private long sequence;

    public LocalSnowflake(long worker, long epochMillis,
                          Clock clock, LeaseGuard lease) {
        if (worker < 0 || worker > WORKER_MAX) {
            throw new IllegalArgumentException("worker out of range");
        }
        this.worker = worker;
        this.epochMillis = epochMillis;
        this.clock = Objects.requireNonNull(clock);
        this.lease = Objects.requireNonNull(lease);
    }

    public synchronized long nextId() {
        lease.ensureUsable();
        long now = clock.millis();
        long delta = Math.subtractExact(now, epochMillis);
        if (delta < 0 || delta > TIME_MAX) {
            throw new IllegalStateException("time outside epoch range");
        }
        if (now < lastMillis) {
            throw new IllegalStateException("clock moved backwards");
        }
        long nextSequence = now == lastMillis ? sequence + 1 : 0;
        if (nextSequence > SEQUENCE_MAX) {
            throw new IllegalStateException("millisecond capacity exhausted");
        }
        sequence = nextSequence;
        lastMillis = now;
        return (delta << 22) | (worker << 12) | sequence;
    }

    public static long workerOf(long id) {
        return (id >>> 12) & WORKER_MAX;
    }
    public static long sequenceOf(long id) {
        return id & SEQUENCE_MAX;
    }
    public long timeOf(long id) {
        return (id >>> 22) + epochMillis;
    }
}